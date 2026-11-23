/**
 * Split-screen terminal for the Hermes TUI.
 *
 *   /term        dock a half-width terminal on the right (chat reflows on the left)
 *                and focus it; run again to hide the rail (the shell keeps running)
 *   /termfocus   give the keyboard to the terminal
 *   ctrl+]       toggle the keyboard between the terminal and the composer
 *                (while the rail is docked)
 *   ctrl+\       show/hide the rail: dock + focus it, or collapse it to a thin strip
 *                (the shell keeps running). Works from the composer or the terminal.
 *
 * How it works: the SDK has no PTY or terminal emulator, so a private tmux
 * server (socket `hermes-tuiterm`, session `term`) provides both. The rail
 * polls `tmux capture-pane -e` and paints the screen; the focus modal forwards
 * keystrokes with `tmux send-keys`. Requires `tmux` on PATH.
 */
import { execFile, execFileSync } from 'node:child_process'

const SOCKET = 'hermes-tuiterm'
const SESSION = 'term'
const POLL_MS = 200

const tmuxArgs = args => ['-L', SOCKET, ...args]

const tmux = args =>
  new Promise(resolve =>
    execFile('tmux', tmuxArgs(args), { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout))
  )

function ensureSession(cols, rows) {
  const run = args => execFileSync('tmux', tmuxArgs(args), { stdio: 'ignore' })

  try {
    run(['has-session', '-t', `=${SESSION}`])

    return true
  } catch {
    // fall through and create it
  }

  try {
    run(['new-session', '-d', '-s', SESSION, '-x', String(cols), '-y', String(rows), '-c', process.cwd()])
    run(['set-option', '-t', SESSION, 'status', 'off'])
    run(['set-option', '-s', 'escape-time', '0'])

    return true
  } catch {
    return false
  }
}

// ── geometry ─────────────────────────────────────────────────────────
// Rail Box: paddingX 1 each side. Card: round border (1 each side).
// So terminal columns = railWidth - 4. Rows: card height minus border (2) and header (1).

const railWidth = () => Math.max(40, Math.floor((process.stdout.columns || 160) / 2))
// The rail sits above the prompt zone + composer + status bar; keep a few spare rows
// so a multi-line composer never overlaps the card.
const cardHeight = rows => Math.max(8, rows - 4)

// ctrl+] as the focus toggle: bare 0x1d, or the kitty keyboard protocol form (CSI 93;5u).
// eslint-disable-next-line no-control-regex
const CTRL_RBRACKET = /^(?:\x1d|\x1b\[93;5(?::\d+)?u)$/

// ctrl+\ as the show/hide toggle (0x1c, or kitty CSI 92;5u). Unbound in the Hermes TUI.
// (ctrl+t is NOT free: it opens the agents/work monitor.)
// eslint-disable-next-line no-control-regex
const CTRL_BACKSLASH = /^(?:\x1c|\x1b\[92;5(?::\d+)?u)$/

// The SDK can open a widget but not close it, so "hide" collapses the rail to the
// minimum the rail container can take (its own paddingX of 1 per side).
const COLLAPSED_WIDTH = 2
const termCols = width => Math.max(10, width - 4)
const termRows = rows => Math.max(4, cardHeight(rows) - 3)

// ── ANSI (SGR) → styled spans ────────────────────────────────────────

const BASIC = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5']
const BRIGHT = ['#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff']
const hex = (r, g, b) => '#' + [r, g, b].map(x => Math.max(0, Math.min(255, x)).toString(16).padStart(2, '0')).join('')

function xterm256(n) {
  if (n < 8) return BASIC[n]
  if (n < 16) return BRIGHT[n - 8]

  if (n < 232) {
    const i = n - 16
    const v = x => (x ? 55 + 40 * x : 0)

    return hex(v(Math.floor(i / 36)), v(Math.floor(i / 6) % 6), v(i % 6))
  }

  const g = 8 + 10 * (n - 232)

  return hex(g, g, g)
}

function applySgr(st, params) {
  const next = { ...st }
  const p = params === '' ? [0] : params.replace(/:/g, ';').split(';').map(x => parseInt(x, 10) || 0)

  for (let i = 0; i < p.length; i++) {
    const c = p[i]

    if (c === 0) Object.keys(next).forEach(k => delete next[k])
    else if (c === 1) next.bold = true
    else if (c === 2) next.dim = true
    else if (c === 3) next.italic = true
    else if (c === 4) next.underline = true
    else if (c === 7) next.inverse = true
    else if (c === 9) next.strikethrough = true
    else if (c === 22) { delete next.bold; delete next.dim }
    else if (c === 23) delete next.italic
    else if (c === 24) delete next.underline
    else if (c === 27) delete next.inverse
    else if (c === 29) delete next.strikethrough
    else if (c >= 30 && c <= 37) next.color = BASIC[c - 30]
    else if (c >= 90 && c <= 97) next.color = BRIGHT[c - 90]
    else if (c >= 40 && c <= 47) next.backgroundColor = BASIC[c - 40]
    else if (c >= 100 && c <= 107) next.backgroundColor = BRIGHT[c - 100]
    else if (c === 39) delete next.color
    else if (c === 49) delete next.backgroundColor
    else if (c === 38 || c === 48) {
      const key = c === 38 ? 'color' : 'backgroundColor'

      if (p[i + 1] === 5) { next[key] = xterm256(p[i + 2] || 0); i += 2 }
      else if (p[i + 1] === 2) { next[key] = hex(p[i + 2] || 0, p[i + 3] || 0, p[i + 4] || 0); i += 4 }
    }
  }

  return next
}

// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b\[([0-9;:]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g

function parseLine(line) {
  const spans = []
  let st = {}
  let last = 0
  let m

  ESC_RE.lastIndex = 0

  while ((m = ESC_RE.exec(line))) {
    if (m.index > last) spans.push({ text: line.slice(last, m.index), st })
    if (m[2] === 'm') st = applySgr(st, m[1])
    last = ESC_RE.lastIndex
  }

  if (last < line.length) spans.push({ text: line.slice(last), st })

  return spans
}

/** Paint a block cursor at column x (pads the line if the cursor is past its end). */
function withCursor(spans, x) {
  const out = []
  let pos = 0
  let done = false

  for (const s of spans) {
    const chars = [...s.text]

    if (!done && x < pos + chars.length) {
      const k = x - pos

      if (k > 0) out.push({ text: chars.slice(0, k).join(''), st: s.st })
      out.push({ text: chars[k], st: { ...s.st, inverse: !s.st.inverse } })
      if (k + 1 < chars.length) out.push({ text: chars.slice(k + 1).join(''), st: s.st })
      done = true
    } else {
      out.push(s)
    }

    pos += chars.length
  }

  if (!done) {
    if (x > pos) out.push({ text: ' '.repeat(x - pos), st: {} })
    out.push({ text: ' ', st: { inverse: true } })
  }

  return out
}

// ── keyboard → tmux ──────────────────────────────────────────────────

const NAMED = [
  ['return', 'Enter'],
  ['tab', 'Tab'],
  ['backspace', 'BSpace'],
  ['delete', 'DC'],
  ['upArrow', 'Up'],
  ['downArrow', 'Down'],
  ['leftArrow', 'Left'],
  ['rightArrow', 'Right'],
  ['pageUp', 'PPage'],
  ['pageDown', 'NPage'],
  ['home', 'Home'],
  ['end', 'End']
]

/** Map one TUI keypress to a tmux send-keys item, or null to drop it. */
function toTmux(ch, key) {
  if (key.wheelUp || key.wheelDown) return null
  if (key.escape && (ch === '\u001b' || ch === '')) return { key: 'Escape' }
  if (key.tab && key.shift) return { key: 'BTab' }

  for (const [flag, name] of NAMED) {
    if (key[flag]) return { key: key.meta && flag !== 'return' ? `M-${name}` : name }
  }

  if (key.ctrl) {
    return /^[a-z]$/i.test(ch) ? { key: `C-${ch.toLowerCase()}` } : null
  }

  if (key.meta && ch.length === 2 && ch[0] === '\u001b') return { key: `M-${ch[1]}` }
  if (!ch || ch.includes('\u001b')) return null

  return { lit: ch }
}

// ── widget ───────────────────────────────────────────────────────────

export default function register(sdk) {
  const { Box, React, Text, defineWidgetApp, h, openWidget, updateWidget } = sdk

  // Serialize key delivery so fast typing and pastes keep their order.
  let chain = Promise.resolve()
  let poke = () => {}

  let railActive = false // rail registered in the dock (visible OR collapsed)
  let collapsed = false // rail collapsed by ctrl+\
  let railVisible = false // rail docked and expanded (Screen mounted)
  let focused = false // focus modal mounted
  let leaveAt = 0 // last time the stdin tap saw ctrl+] while focused

  const send = item => {
    const args =
      item.lit !== undefined
        ? ['send-keys', '-t', SESSION, '-l', '--', item.lit.replace(/;$/, '\\;')]
        : ['send-keys', '-t', SESSION, item.key]

    chain = chain.then(() => tmux(args)).then(() => poke())
  }

  const spanProps = st => {
    const props = {}

    for (const k of ['color', 'backgroundColor', 'bold', 'dim', 'italic', 'underline', 'inverse', 'strikethrough']) {
      if (st[k] !== undefined) props[k] = st[k]
    }

    return props
  }

  function Screen({ cols, rows, focused }) {
    const [snap, setSnap] = React.useState({ lines: [], cx: 0, cy: 0 })

    React.useEffect(() => {
      railVisible = true

      return () => {
        railVisible = false
      }
    }, [])

    React.useEffect(() => {
      let alive = true
      let busy = false
      let lastOut = null

      const tick = async () => {
        if (busy) return
        busy = true

        try {
          const out = await tmux([
            'capture-pane', '-p', '-e', '-t', SESSION,
            ';',
            'display-message', '-p', '-t', SESSION, '#{cursor_x},#{cursor_y},#{cursor_flag}'
          ])

          if (!alive) return

          if (out === null) {
            // Session gone (shell exited): start a fresh one.
            ensureSession(cols, rows)

            return
          }

          if (out === lastOut) return
          lastOut = out

          const lines = out.split('\n')

          if (lines[lines.length - 1] === '') lines.pop()

          const [cx, cy, cursorOn] = (lines.pop() || '0,0,1').split(',').map(n => parseInt(n, 10) || 0)

          // cursor_flag=0: the program hid the hardware cursor and paints its own (helix, vim
          // with a custom cursor, TUIs). Drawing ours too would double-highlight that cell.
          setSnap({ lines, cx, cy, cursorOn: cursorOn === 1 })
        } finally {
          busy = false
        }
      }

      poke = () => setTimeout(() => void tick(), 15)
      ensureSession(cols, rows)
      void tmux(['resize-window', '-t', SESSION, '-x', String(cols), '-y', String(rows)]).then(() => tick())
      const id = setInterval(() => void tick(), POLL_MS)

      return () => {
        alive = false
        clearInterval(id)
        poke = () => {}
      }
    }, [cols, rows])

    const rowsOut = []

    for (let y = 0; y < rows; y++) {
      let spans = parseLine(snap.lines[y] ?? '')

      if (focused && snap.cursorOn && y === snap.cy) spans = withCursor(spans, snap.cx)

      rowsOut.push(
        h(
          Box,
          { flexShrink: 0, height: 1, key: y, width: cols },
          h(
            Text,
            { wrap: 'truncate' },
            spans.length
              ? spans.map((s, i) => h(Text, { key: i, ...spanProps(s.st) }, s.text))
              : ' '
          )
        )
      )
    }

    return h(Box, { flexDirection: 'column', height: rows, width: cols }, rowsOut)
  }

  const termApp = defineWidgetApp({
    id: 'term',
    help: 'split screen: embedded terminal on the right (ctrl+] leaves it)',
    mode: 'ambient',
    zone: 'top-right',
    width: railWidth(),
    usage: 'usage: /term',

    init() {
      if (!ensureSession(termCols(railWidth()), 24)) return null

      collapsed = false
      termApp.width = railWidth()
      openWidget(focusApp, {})

      return { collapsed: false, focused: true }
    },

    reduce: state => state,

    render({ state, t, rows }) {
      if (state.collapsed) return h(Presence)

      const width = termApp.width
      const cols = termCols(width)
      const r = termRows(rows)
      const accent = state.focused ? t.color.primary : t.color.muted

      return h(
        Presence,
        null,
        h(
          Box,
          { borderColor: accent, borderStyle: 'round', flexDirection: 'column', flexShrink: 0, height: cardHeight(rows), width: width - 2 },
          h(
            Text,
            { color: accent, wrap: 'truncate' },
            state.focused ? ' ● term · ctrl+] chat · ctrl+\\ hide' : ' ○ term · ctrl+] focus · ctrl+\\ hide'
          ),
          h(Screen, { cols, focused: state.focused, rows: r })
        )
      )
    }
  })

  // Mounted whenever the rail is in the dock (expanded or collapsed): tells the key tap
  // whether ctrl+\ should show a rail or collapse one. Resets `collapsed` when the rail goes away.
  function Presence({ children }) {
    React.useEffect(() => {
      railActive = true

      return () => {
        railActive = false
        collapsed = false
      }
    }, [])

    return children ?? null
  }

  // ctrl+\ : not docked -> dock + focus; collapsed -> expand + focus; expanded -> collapse.
  function toggleRail() {
    if (!railActive) {
      if (!ensureSession(termCols(railWidth()), 24)) return

      collapsed = false
      termApp.width = railWidth()
      openWidget(termApp, { collapsed: false, focused: true })
      openWidget(focusApp, {})
    } else if (collapsed) {
      collapsed = false
      termApp.width = railWidth()
      updateWidget(termApp, s => ({ ...s, collapsed: false }))
      openWidget(focusApp, {})
    } else {
      collapsed = true
      termApp.width = COLLAPSED_WIDTH
      updateWidget(termApp, s => ({ ...s, collapsed: true, focused: false }))
    }
  }

  // Tracks focus: while the modal is mounted, the rail shows the cursor.
  function Beacon() {
    React.useEffect(() => {
      focused = true
      // Published for other widgets' key taps (e.g. gitstat's ctrl+f): while the terminal is
      // focused, their chords must reach the shell instead.
      globalThis.__hermesTermFocused = true
      updateWidget(termApp, s => ({ ...s, focused: true }))

      return () => {
        focused = false
        globalThis.__hermesTermFocused = false
        updateWidget(termApp, s => ({ ...s, focused: false }))
      }
    }, [])

    return null
  }

  const focusApp = defineWidgetApp({
    id: 'termfocus',
    help: 'send keystrokes to the embedded terminal (ctrl+] leaves)',
    mode: 'modal',
    usage: 'usage: /termfocus',

    init() {
      if (!ensureSession(termCols(railWidth()), 24)) return null

      collapsed = false
      termApp.width = railWidth()
      openWidget(termApp, { collapsed: false, focused: true })

      return {}
    },

    reduce(state, { ch, key }) {
      // The key parser only flags ctrl for bytes <= 0x1a, so bare ctrl+] (0x1d) arrives as a plain
      // char; under the kitty protocol it is ctrl + ']'. The stdin tap also stamps `leaveAt` for it.
      if (ch === '\u001d' || (key.ctrl && ch === ']') || Date.now() - leaveAt < 100) return null

      const item = toTmux(ch, key)

      if (item) send(item)

      return state
    },

    render: () => h(Beacon)
  })

  // Global ctrl+] toggle. The widget SDK has no global key hook (ambient widgets receive no keys),
  // so tap Ink's stdin.read(): a LONE ctrl+] chunk, while the rail is docked and unfocused, is
  // consumed and opens the focus modal. While focused it is passed through untouched (the modal
  // leaves on it). Any error falls back to plain pass-through, so input can never be lost.
  const gs = globalThis
  if (gs.__hermesTermStdinRestore) gs.__hermesTermStdinRestore()

  const stdin = process.stdin
  const hadOwnRead = Object.prototype.hasOwnProperty.call(stdin, 'read')
  const origRead = stdin.read
  let live = true // false once a reload replaced this tap: it then only passes chunks through

  const tappedRead = function (...args) {
    const chunk = origRead.apply(this, args)

    if (!live) return chunk

    try {
      const s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('latin1') : ''

      if (s && CTRL_BACKSLASH.test(s)) {
        // While focused the chunk passes through so the modal closes on it (via leaveAt);
        // otherwise swallow it like ctrl+] does.
        if (focused) leaveAt = Date.now()

        toggleRail()

        if (!focused) return origRead.apply(this, args)
      } else if (s && CTRL_RBRACKET.test(s)) {
        if (focused) {
          leaveAt = Date.now()
        } else if (railVisible) {
          openWidget(focusApp, {})

          // Swallow the keystroke, but let Node's real read() produce the next value (normally
          // null). Returning null ourselves skips that call and can leave 'readable' un-armed.
          return origRead.apply(this, args)
        }
      }
    } catch {
      // fall through: deliver the chunk
    }

    return chunk
  }

  stdin.read = tappedRead
  gs.__hermesTermStdinRestore = () => {
    // Another widget may have tapped stdin.read on top of this one, so unwrapping is not always
    // possible. Going inert always is: a dead tap just passes chunks through.
    live = false
    if (stdin.read !== tappedRead) return
    if (hadOwnRead) stdin.read = origRead
    else delete stdin.read
  }

  // Keep the rail at half the screen when the terminal is resized.
  const g = globalThis
  if (g.__hermesTermResize) process.stdout.off('resize', g.__hermesTermResize)
  g.__hermesTermResize = () => { termApp.width = collapsed ? COLLAPSED_WIDTH : railWidth() }
  process.stdout.on('resize', g.__hermesTermResize)
}
