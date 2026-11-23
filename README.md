# hermes-tui-widgets

> **Disclaimer:** this repo is 100% vibe coding. The code was written by an AI agent and only tested by driving a real TUI session by hand. Review it before you trust it, and expect rough edges.

Widgets for the [Hermes Agent](https://hermes-agent.nousresearch.com/docs) Ink TUI. Each widget is one self-contained `.mjs` file. Install only the ones you want.

| Widget | File | What it does | Keys |
|---|---|---|---|
| [term](#term-split-screen-terminal) | `term.mjs` | Split-screen terminal: a real shell in a half-width rail next to the chat | `/term`, `ctrl+]`, `ctrl+\` |
| [gitstat](#gitstat-git-status-and-diff-viewer) | `gitstat.mjs` | Git status panel: staged, unstaged and untracked files, with a diff viewer | `/gitstat`, `ctrl+f` |

![Hermes TUI split-screen: chat on the left, Helix running in the embedded terminal on the right](docs/screenshot.png)

## Requirements

- Hermes Agent with the Ink TUI (`hermes --tui`). Developed against v0.22.7.
- Node ESM runtime as shipped with the Hermes TUI. No build step, no dependencies.
- `term`: `tmux` on `PATH` (developed with 3.8).
- `gitstat`: `git` on `PATH`.

## Install

Widgets are plain `.mjs` files loaded from `$HERMES_HOME/tui-widgets/` (`~/.hermes/tui-widgets/` for the default profile).

```sh
# for a specific profile
cp term.mjs gitstat.mjs ~/.hermes/profiles/<profile>/tui-widgets/

# or the default profile
cp term.mjs gitstat.mjs ~/.hermes/tui-widgets/
```

A running TUI hot-loads the files within about a second. Run `/widgets-reload` to force a rescan; the transcript should list the files under `loaded:`.

To use them for every profile, symlink instead of copying.

Uninstall: delete the file. Its global key hook is removed with it.

Tip: type a trailing space (`/term `, `/gitstat `). The slash popover fuzzy-ranks, so `/term` + Enter can select `/redraw`.

---

## term: split-screen terminal

The chat stays on the left; a real shell lives in a half-width rail on the right.

- `/term` docks the terminal and focuses it. Run it again to hide the rail (the shell keeps running).
- `/termfocus` gives the keyboard to the terminal.
- `ctrl+]` toggles the keyboard between the chat composer and the terminal while the rail is docked.
- `ctrl+\` shows or hides the rail from anywhere: it docks and focuses the terminal, or collapses it to a thin strip. The shell keeps running while hidden.

### How it works

- A private tmux server (socket `hermes-tuiterm`, session `term`) runs your shell. It never touches your normal tmux server.
- An **ambient** right-side rail polls `tmux capture-pane -p -e` every 200 ms, parses the SGR colors into styled `Text` spans, and paints the screen. The chat transcript reflows into the left half.
- A **modal** focus app forwards keystrokes with `tmux send-keys`, serialized so fast typing and pastes keep their order.
- The rail resizes with the terminal; the inner tmux window follows.
- The terminal cursor is painted only when the program shows the real cursor (`#{cursor_flag}` = 1). Programs such as Helix hide it and draw their own.

### Why ctrl+\ and not ctrl+t

`ctrl+t` is already a built-in Hermes binding (the agents / work monitor), and binding it here would shadow that. `ctrl+\` (byte `0x1c`) is unused by the Hermes TUI. Both chords are matched in their bare form and in the kitty keyboard protocol form (`ESC[92;5u` / `ESC[93;5u`). The chords are the `CTRL_BACKSLASH` and `CTRL_RBRACKET` constants at the top of `term.mjs`.

The widget SDK can open a widget but not close one, so "hide" collapses the rail to a 2-column strip instead of removing it. Consequence: `/term` while the rail is collapsed removes that strip without showing anything, and a second `/term` docks the terminal again. Use `ctrl+\` to avoid the extra step.

### Behavior notes and limitations

- While the terminal is focused, the composer is blocked. Press `ctrl+]` to get it back.
- `ctrl+]` and `ctrl+\` are reserved inside the terminal. Programs that use them will not see them: `telnet` uses `ctrl+]`, and `ctrl+\` is the shell's SIGQUIT key.
- `ctrl+\` can be awkward to type on some non-US keyboard layouts. Change `CTRL_BACKSLASH` if so.
- Mouse and scrollback inside the rail are not forwarded.
- Keystrokes can lag by up to about 200 ms (poll interval, plus a quick refresh after each key).
- Rail height is `rows - 4` (see `cardHeight()`), leaving room for the status bar and composer. A multi-line composer could overlap a taller card.
- The rail is half the screen width, fixed at launch and on resize.
- Exiting the shell starts a fresh one.
- Known cosmetic issue: Helix inside the rail can look slightly off. Not fully diagnosed. Nerd-font glyphs may also leave the right border off by a column on some rows.
- A live rail keeps running the code it was mounted with. After editing the file, hide and re-show it (`/term ` twice). Until then `ctrl+]` may do nothing.

---

## gitstat: git status and diff viewer

A modal panel listing the changes in the repository the TUI was launched in, grouped into **Staged**, **Unstaged** and **Untracked**, with a scrollable, colored diff for each file. Read-only: it never stages, unstages or discards anything.

- `/gitstat` opens it for the launch folder (`HERMES_CWD`); `/gitstat <path>` opens it for another repo.
- `ctrl+f` opens it from anywhere, and closes it again while it is open.

| View | Keys |
|---|---|
| list | `j`/`k` or arrows move · `tab`/`shift+tab` next/previous section · `g`/`G` first/last file · `enter` open diff · `r` refresh · `q` close |
| diff | `j`/`k` or arrows scroll · `pgup`/`pgdn` or space page · `g`/`G` top/end · `n`/`p` next/previous file · `esc` back to the list · `q` close |

`esc` always steps back one level and `q` always closes. In the list (the top level) `esc` does nothing.

### How it works

- `git status --porcelain=v1 -z --untracked-files=all` builds the file list. A file with both staged and unstaged changes appears in both sections.
- Diffs come from `git diff --cached` (staged), `git diff` (unstaged) and `git diff --no-index /dev/null <file>` (untracked), capped at 5000 lines.
- The widget's own `process.cwd()` is the Hermes install, not your folder, so the launch directory is read from `HERMES_CWD`.
- `ctrl+f` uses the same `stdin.read` hook as `term` (see below). The chord is the `CTRL_F` constant at the top of `gitstat.mjs`.

### Behavior notes and limitations

- `ctrl+f` is swallowed by the hook only when it opens the panel. While the `term` rail is focused it goes to the shell (readline forward-char), and while the panel is open it closes the panel.
- `ctrl+f` opens the panel over whatever is on screen, including another widget's modal or a built-in prompt. Closing it returns to what was there, except another widget's modal, which it replaces.
- Git runs synchronously. Very large repos can make opening or refreshing feel sluggish.
- The list does not auto-refresh. Press `r` after changing files.
- Renames show the new path only.

---

## Global key hooks

The widget SDK has no global hotkeys: ambient widgets receive no keys, and the input handler only talks to a widget while a modal is open. So both widgets wrap `process.stdin.read`:

- Only a **lone** chord chunk is acted on; everything else passes through untouched. Any error falls back to plain pass-through, so input is never lost.
- To swallow a key the hook delegates to the real `read()` and never returns `null` itself. Returning `null` skips a call Node needs to re-arm `readable` and freezes all TUI input.
- Every chord is matched in its bare byte form and in the kitty keyboard protocol form (`ESC[<code>;5u`).
- **Stacking:** each widget installs its own hook, so they chain. A hook cannot unwrap itself once another one sits on top of it, so on hot reload the old hook first turns inert (pass-through only), then unwraps if it is still on top.
- **Sharing state:** `term` sets `globalThis.__hermesTermFocused` while the terminal has the keyboard. `gitstat` checks it so that `ctrl+f` reaches the shell instead of opening the panel.

Chords used: `ctrl+]` (`0x1d`), `ctrl+\` (`0x1c`), `ctrl+f` (`0x06`). Not used because Hermes already binds them: `ctrl+t` (agents monitor) and `ctrl+g` (compose the prompt in `$EDITOR`).

This is a hack on the TUI's input path; a future Hermes release could break it. Removing the files undoes it.

## Tested

Driven through a real `hermes --tui` session in tmux:

- **term** (200x50): dock and focus, typing including a trailing `;`, Enter, arrows, Ctrl+C, colors, `hx` (insert mode, Esc), resize, shell restart after `exit`, hide/show, and the `ctrl+]` toggle in both directions with both key encodings.
- **gitstat** (160x45, against a scratch repo): list and diff views, `esc` back / `q` close in every view, `ctrl+f` open/close from the composer (typed text kept), list and diff, with both key encodings; with `term` focused `ctrl+f` reached the shell; both widgets still worked after repeated hot reloads of both files.

## License

MIT
