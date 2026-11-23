/**
 * Git status panel: staged, unstaged and untracked changes in the repo the
 * TUI runs in, with a scrollable diff for each file. Modal: owns the keyboard
 * while open.
 *
 *   /gitstat [path]        open for the repo at path (default: launch folder)
 *   ctrl+f                 open (launch folder) / close, from anywhere except the focused term
 *   list:  j/k or arrows   move          tab / shift+tab   next / previous section
 *          enter           open diff     g / G             first / last file
 *          r               refresh       q                 close
 *   diff:  j/k or arrows   scroll        pgup / pgdn       page
 *          g / G           top / end     n / p             next / previous file
 *          esc             back to list  q                 close
 */
import { execFileSync } from 'node:child_process'

const MAX_DIFF_LINES = 5000

// ctrl+f as the open/close hotkey: bare 0x06, or the kitty keyboard protocol form (CSI 102;5u).
// Free in the Hermes TUI (ctrl+g is taken: it opens $EDITOR for the prompt).
// eslint-disable-next-line no-control-regex
const CTRL_F = /^(?:\x06|\x1b\[102;5(?::\d+)?u)$/
const isCtrlF = (ch, key) => ch === '\x06' || (key.ctrl && ch === 'f')
const SECTIONS = ['staged', 'unstaged', 'untracked']
const SECTION_LABEL = { staged: 'Staged', unstaged: 'Unstaged', untracked: 'Untracked' }

// ── git helpers (synchronous, local, output capped) ─────────────────

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function repoRoot(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim()
  } catch {
    return null
  }
}

function readRepo(root) {
  let branch = '?'

  try {
    branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  } catch {
    /* unborn branch: keep the placeholder */
  }

  const recs = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split('\0')
  const staged = []
  const unstaged = []
  const untracked = []

  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    if (rec.length < 4) continue

    const x = rec[0]
    const y = rec[1]
    const path = rec.slice(3)

    // Index renames and copies are followed by a record holding the old path.
    if (x === 'R' || x === 'C') i++

    if (x === '?' && y === '?') {
      untracked.push({ section: 'untracked', code: '??', path })
      continue
    }

    if (x !== ' ') staged.push({ section: 'staged', code: x, path })
    if (y !== ' ') unstaged.push({ section: 'unstaged', code: y, path })
  }

  return { root, branch, files: [...staged, ...unstaged, ...untracked] }
}

function readDiff(root, f) {
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (f.section === 'staged') args.push('--cached')
  if (f.section === 'untracked') args.push('--no-index')
  args.push('--')
  if (f.section === 'untracked') args.push('/dev/null')
  args.push(f.path)

  let text
  try {
    text = git(root, args)
  } catch (e) {
    // --no-index exits 1 when the files differ, so the diff is in stdout.
    text = typeof e.stdout === 'string' ? e.stdout : ''
    if (!text) text = `git diff failed: ${String(e.message).split('\n')[0]}`
  }

  const lines = text.replace(/\r/g, '').split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()

  const truncated = lines.length > MAX_DIFF_LINES
  return { lines: truncated ? lines.slice(0, MAX_DIFF_LINES) : lines, truncated, scroll: 0 }
}

function openDiff(s) {
  const file = s.files[s.cursor]
  return { file, ...readDiff(s.root, file) }
}

// ── layout ───────────────────────────────────────────────────────────

const termRows = () => process.stdout.rows || 24
const termCols = () => process.stdout.columns || 80
const bodyRows = () => Math.max(4, termRows() - 12)
const dialogWidth = () => Math.min(Math.max(50, termCols() - 6), 120)
const innerWidth = () => dialogWidth() - 6

function clip(s, n) {
  return s.length > n ? s.slice(0, Math.max(0, n - 3)) + '...' : s
}

function codeColor(code, t) {
  if (code === '??' || code === 'A') return t.color.ok
  if (code === 'D') return t.color.error
  return t.color.label
}

function lineColor(line, t) {
  if (/^(\+\+\+|---|diff |index |new file|deleted file|similarity|rename |old mode|new mode)/.test(line)) return t.color.muted
  if (line.startsWith('@@')) return t.color.primary
  if (line.startsWith('+')) return t.color.ok
  if (line.startsWith('-')) return t.color.error
  return t.color.text
}

function windowOf(total, pos, height) {
  const start = Math.max(0, Math.min(pos - Math.floor(height / 2), total - height))
  return { start, end: Math.min(total, start + height) }
}

function fileLines(s) {
  const out = []
  let section = null

  s.files.forEach((f, idx) => {
    if (f.section !== section) {
      section = f.section
      const n = s.files.filter(g => g.section === section).length
      out.push({ head: `${SECTION_LABEL[section]} (${n})` })
    }
    out.push({ idx })
  })

  return out
}

function countBy(s) {
  const n = { staged: 0, unstaged: 0, untracked: 0 }
  for (const f of s.files) n[f.section]++
  return `staged ${n.staged} · unstaged ${n.unstaged} · untracked ${n.untracked}`
}

// ── reducers ─────────────────────────────────────────────────────────

function jumpSection(s, dir) {
  if (!s.files.length) return s

  const current = s.files[s.cursor].section
  const present = SECTIONS.filter(sec => s.files.some(f => f.section === sec))
  const i = present.indexOf(current)
  const target = present[(i + dir + present.length) % present.length]

  return { ...s, cursor: s.files.findIndex(f => f.section === target) }
}

function refresh(s) {
  try {
    const r = readRepo(s.root)
    const cursor = Math.max(0, Math.min(s.cursor, r.files.length - 1))
    return { ...s, ...r, cursor, error: null }
  } catch (e) {
    return { ...s, error: `git status failed: ${String(e.message).split('\n')[0]}` }
  }
}

function reduceList(s, ch, key) {
  // esc steps back one level; the list is the top, so only q closes here.
  if (ch === 'q') return null

  const last = s.files.length - 1
  const move = to => ({ ...s, cursor: Math.max(0, Math.min(last, to)) })

  if (key.downArrow || ch === 'j') return move(s.cursor + 1)
  if (key.upArrow || ch === 'k') return move(s.cursor - 1)
  if (ch === 'g') return move(0)
  if (ch === 'G') return move(last)
  if (key.tab) return jumpSection(s, key.shift ? -1 : 1)
  if (key.return) return last < 0 ? s : { ...s, view: 'diff', diff: openDiff(s) }
  if (ch === 'r') return refresh(s)

  return s
}

function reduceDiff(s, ch, key) {
  if (ch === 'q') return null
  if (key.escape) return { ...s, view: 'list', diff: null }

  const d = s.diff
  const page = bodyRows()
  const max = Math.max(0, d.lines.length - page)
  const scrollTo = n => ({ ...s, diff: { ...d, scroll: Math.max(0, Math.min(max, n)) } })

  if (key.downArrow || ch === 'j') return scrollTo(d.scroll + 1)
  if (key.upArrow || ch === 'k') return scrollTo(d.scroll - 1)
  if (key.pageDown || ch === ' ') return scrollTo(d.scroll + page)
  if (key.pageUp) return scrollTo(d.scroll - page)
  if (ch === 'g') return scrollTo(0)
  if (ch === 'G') return scrollTo(max)

  if (ch === 'n' || ch === 'p') {
    const idx = s.cursor + (ch === 'n' ? 1 : -1)
    if (idx < 0 || idx >= s.files.length) return s
    const next = { ...s, cursor: idx }
    return { ...next, diff: openDiff(next) }
  }

  return s
}

// ── views ────────────────────────────────────────────────────────────

function ListBody({ s, t, h, Box, Text }) {
  const height = bodyRows()
  const lines = fileLines(s)
  const cursorLine = lines.findIndex(l => l.idx === s.cursor)
  const { start, end } = windowOf(lines.length, cursorLine, height)
  const rows = []

  for (let i = start; i < end; i++) {
    const line = lines[i]

    if (line.head) {
      rows.push(h(Text, { key: `h${i}`, bold: true, color: t.color.label }, line.head))
      continue
    }

    const f = s.files[line.idx]
    const selected = line.idx === s.cursor
    const marker = selected ? '› ' : '  '
    const pathWidth = Math.max(8, innerWidth() - 6)

    rows.push(
      h(
        Text,
        { key: `f${i}`, color: selected ? t.color.primary : t.color.text, bold: selected },
        h(Text, { color: codeColor(f.code, t) }, `${marker}${f.code.padEnd(2)} `),
        clip(f.path, pathWidth)
      )
    )
  }

  while (rows.length < height) rows.push(h(Text, { key: `p${rows.length}` }, ' '))

  return h(Box, { flexDirection: 'column' }, ...rows)
}

function DiffBody({ d, t, h, Box, Text }) {
  const height = bodyRows()
  const inner = innerWidth()
  const source = d.lines.length ? d.lines : ['(no textual diff)']
  const rows = source.slice(d.scroll, d.scroll + height).map((line, i) =>
    h(Text, { key: `d${i}`, color: lineColor(line, t) }, clip(line.replace(/\t/g, '    '), inner))
  )

  while (rows.length < height) rows.push(h(Text, { key: `p${rows.length}` }, ' '))

  return h(Box, { flexDirection: 'column' }, ...rows)
}

// ── widget ───────────────────────────────────────────────────────────

export default function register(sdk) {
  const { Box, Dialog, Overlay, React, Text, defineWidgetApp, h, openWidget } = sdk

  let open = false // modal mounted; set by Beacon so it is right however the panel closed

  function Beacon() {
    React.useEffect(() => {
      open = true

      return () => {
        open = false
      }
    }, [])

    return null
  }

  const app = defineWidgetApp({
    id: 'gitstat',
    help: 'git status: staged / unstaged / untracked, with diff viewer',
    mode: 'modal',

    init(arg) {
      // The TUI's own process.cwd() is the Hermes install, not the user's folder.
      // HERMES_CWD is the launch directory the TUI itself uses for the status bar.
      const dir = arg.trim() || process.env.HERMES_CWD || process.cwd()
      const root = repoRoot(dir)

      if (!root) {
        return { error: `not a git repository: ${dir}`, files: [], cursor: 0, view: 'list', diff: null }
      }

      try {
        return { ...readRepo(root), cursor: 0, view: 'list', diff: null, error: null }
      } catch (e) {
        return { root, error: `git status failed: ${String(e.message).split('\n')[0]}`, files: [], cursor: 0, view: 'list', diff: null }
      }
    },

    reduce(state, { ch, key }) {
      if (isCtrlF(ch, key)) return null
      if (state.error) return ch === 'q' ? null : state
      return state.view === 'diff' ? reduceDiff(state, ch, key) : reduceList(state, ch, key)
    },

    render({ state, t }) {
      const width = dialogWidth()
      let title
      let hint
      let body

      if (state.error) {
        title = 'git status'
        hint = 'q to close'
        body = h(Text, { color: t.color.error }, clip(state.error, innerWidth()))
      } else if (state.view === 'diff' && state.diff) {
        const d = state.diff
        const added = d.lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).length
        const removed = d.lines.filter(l => l.startsWith('-') && !l.startsWith('---')).length
        title = clip(`${d.file.code} ${d.file.path}`, innerWidth())
        hint = `j/k scroll · pgup/pgdn page · n/p file · esc back · q close`
        body = h(
          Box,
          { flexDirection: 'column' },
          h(Text, { color: t.color.muted }, `+${added} -${removed}${d.truncated ? `  (first ${MAX_DIFF_LINES} lines)` : ''}  line ${d.scroll + 1}/${Math.max(1, d.lines.length)}`),
          h(DiffBody, { d, t, h, Box, Text })
        )
      } else {
        title = `git · ${state.branch}`
        hint = 'j/k move · tab section · enter diff · r refresh · q close'
        body = h(
          Box,
          { flexDirection: 'column' },
          h(Text, { color: t.color.muted }, state.files.length ? countBy(state) : 'Working tree clean.'),
          h(ListBody, { s: state, t, h, Box, Text })
        )
      }

      return h(
        Overlay,
        { backdrop: true, zone: 'center' },
        h(Beacon),
        h(Dialog, { width, title, hint }, body)
      )
    }
  })

  // Global ctrl+f. The widget SDK has no global key hook, so tap Ink's stdin.read() (same approach
  // as term.mjs). A LONE ctrl+f chunk opens the panel when it is closed and the embedded terminal
  // is not focused; everything else, including ctrl+f while open (the reducer closes on it), passes
  // through. Any error falls back to pass-through, so input can never be lost.
  const gs = globalThis
  if (gs.__hermesGitstatStdinRestore) gs.__hermesGitstatStdinRestore()

  const stdin = process.stdin
  const hadOwnRead = Object.prototype.hasOwnProperty.call(stdin, 'read')
  const origRead = stdin.read
  let live = true // false once a reload replaced this tap: it then only passes chunks through

  const tappedRead = function (...args) {
    const chunk = origRead.apply(this, args)

    if (!live || open || gs.__hermesTermFocused) return chunk

    try {
      const s = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('latin1') : ''

      if (s && CTRL_F.test(s)) {
        const state = app.init('')

        if (state) {
          openWidget(app, state)

          // Swallow the keystroke, but let the real read() produce the next value (normally null).
          return origRead.apply(this, args)
        }
      }
    } catch {
      // fall through: deliver the chunk
    }

    return chunk
  }

  stdin.read = tappedRead
  gs.__hermesGitstatStdinRestore = () => {
    // Another widget may have tapped on top of this one; going inert is always safe.
    live = false
    if (stdin.read !== tappedRead) return
    if (hadOwnRead) stdin.read = origRead
    else delete stdin.read
  }
}
