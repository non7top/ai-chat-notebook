# AI Chat Notebook

A local archive and organizer for Google Search **AI Mode** conversations
(`google.com/search?udm=50`). Google's own history is a flat, unnamed,
newest-first list that is prunable and subject to an auto-delete window — this
app pulls those conversations into a **complete offline copy (text and
images)**, lets them be named and filed into a folder tree by hand, and lets
any saved conversation be **resumed** in an embedded browser panel, with the
new turns saving straight back.

See [project.md](project.md) for the original brief.

The archive is the point, not a cache: once a conversation is here it should
render fully with the network off.

## How it works

- An embedded browser panel (Electron `WebContentsView`) on a persistent
  session holds your Google login — you sign in by hand once per machine.
- A harvester walks the AI Mode history panel and stores each conversation:
  turns as text plus a sanitised HTML snapshot, with every image downloaded
  locally and the HTML rewritten to point at the local copies.
- You organize by hand: nested folders, one folder per chat, drag to reparent.
- Pick a folder and start a new conversation in it, or hit **Resume** on a
  saved one — either way the panel navigates to the real page and live capture
  files the result into that folder.
- Google sometimes surfaces one conversation as two threads; likely duplicates
  are flagged for a manual, undoable merge rather than collapsed automatically.

This is deliberately built as a second [PromptLoom](../sprite-manager) — same
Electron + React + `node:sqlite` stack and the same
embedded-view-with-persisted-session approach, which that project already
proved out against a hostile third-party page.

## Status

Early, but the organizer half works.

Implemented: the app shell and split layout, the embedded AI Mode panel on a
persistent session, the database schema, folder CRUD with drag-to-reparent
(including the cycle guard), the chat list, and the offline reader with
sanitised HTML and local images.

Not built yet: the harvester, the asset download pipeline, live capture,
Resume, duplicate merge, and search.

**The AI Mode page structure has not been verified against the live site.**
The landing URL in `src/main/aiModeView.ts` is based on research, not a check,
and is overridable with `NOTEBOOK_AI_MODE_URL` while that gets pinned down.
Nothing that scrapes the page should be written before that recon is done.

### Trying it without a harvester

`NOTEBOOK_DEV_SEED=1` inserts a few sample folders and conversations (one
deliberately unnamed, one unfiled, one containing an image) so the tree, the
reader and the image path can be exercised. It is idempotent and safe to leave
off in normal use.

```sh
docker compose run --rm -e DISPLAY -e NOTEBOOK_DEV_SEED=1 dev npm start
```

The seed also reads its own work back through the same functions the UI calls
and prints a `[Notebook] dev seed:` summary, including a check that the folder
cycle guard rejects a self-nesting move.

## Development

All tooling runs in Docker — nothing needs to be installed on the host.

```sh
docker compose build dev
docker compose run --rm dev npm install
docker compose run --rm dev npm run lint
docker compose run --rm dev npx tsc --noEmit
docker compose run --rm dev npm run build
```

To run the app itself, Electron needs a display. On Linux, forward your X
server into the container:

```sh
xhost +local:docker
docker compose run --rm -e DISPLAY dev npm start
```

Under pure headless Xvfb the app boots fine against a trivial page:

```sh
docker compose run --rm -e NOTEBOOK_AI_MODE_URL=about:blank dev xvfb-run -a npx electron .
```

Expect that to stop being true once the real Google page loads — PromptLoom hit
exactly this, with Chromium's GPU process crashing on the live JS-heavy page
under Xvfb while running fine with a forwarded X server. Google Search is
heavier still. Use the X11-forwarding setup for anything touching the live page.

The `dbus` connection errors printed in the container are normal and unrelated
to the app.

### Debugging the embedded panel

Right-click "Inspect Element" does not reach into a `WebContentsView`, and the
default "Toggle Developer Tools" menu role only targets the window's own web
contents. Use **Debug → Open AI Mode DevTools** in the app menu — that is the
only way to see console output from injected scripts or to run diagnostic JS
against the real page.

### Remote debugging (CDP)

For driving the app from outside — including inspecting the live AI Mode page
without sitting at the machine — start it with a debugging port:

```
"AI Chat Notebook.exe" --devtools-port=9222
```

`NOTEBOOK_REMOTE_DEBUGGING_PORT=9222` does the same thing, for launches where
setting an env var is easier than editing a shortcut. Either way the app prints
a warning line at startup confirming it is on.

Targets are then listed at `http://127.0.0.1:9222/json`; the embedded panel
appears as its own page target alongside the app's own UI.

Two things that are easy to lose an hour to:

- **The port is bound to loopback only**, and that is left that way on purpose.
  Reaching it from another machine means forwarding it deliberately —
  `ssh -L 9222:127.0.0.1:9222 user@host`, Tailscale, or similar.
- **It is completely unauthenticated.** There is no token and no prompt. Anyone
  who reaches that port has full control of a browser holding a live, logged-in
  Google session, which is strictly worse than leaking a password. Do not put it
  on a public interface, and turn it off when you are done — it is opt-in for
  exactly this reason.

`--remote-allow-origins=*` is set automatically alongside the port: since
Chromium 111 a CDP WebSocket handshake carrying a non-allow-listed `Origin`
header is rejected with a bare 403, which most remote clients hit and local
ones do not.

## Dependencies

Kept deliberately short.

Runtime:
- `react`, `react-dom` — the sidebar UI
- `electron-context-menu` — Electron shows no right-click menu anywhere by
  default; this adds the standard cut/copy/paste/inspect-element menu

Storage uses Node's built-in `node:sqlite`, so there is no SQLite dependency.
Electron 43's bundled SQLite **does** include FTS5 (verified at runtime, and
re-probed on every boot — see the `FTS5 available` log line, since an Electron
upgrade could flip it and silently downgrade search to the `LIKE` path).

Dev/build:
- `electron`, `electron-vite`, `electron-builder`, `@electron/fuses` — build,
  package and publish. `@electron/fuses` is applied via
  `scripts/afterPack.cjs`, since electron-builder has no built-in fuses support.
- `vite`, `@vitejs/plugin-react` — bundling, driven by `electron.vite.config.ts`
- `typescript`, `@types/*` — type-checking
- `@biomejs/biome` — linting (formatter and import-sorting deliberately off)

The build tooling choices (electron-vite over electron-forge's Vite plugin, the
`electron-vite@6.0.0-beta.1` pin for `vite@^8`, and
`publish.releaseType: release` in `electron-builder.yml`) are all carried over
from PromptLoom, where each one was arrived at the hard way — see
[../sprite-manager/README.md](../sprite-manager/README.md#build-tooling--known-hurdles)
for the reasoning rather than rediscovering it.

## Security notes

- The embedded panel holds a **live, logged-in Google session**, and the app's
  `userData` directory therefore holds Google session cookies alongside the
  archive.
- The renderer's CSP (in `index.html`) deliberately allows no remote image
  sources. If the asset-rewriting pass ever misses a URL, the image breaks
  visibly instead of silently re-fetching from Google every time an archived
  conversation is opened.
- HTML captured from Google is sanitised before it is ever stored or rendered.
