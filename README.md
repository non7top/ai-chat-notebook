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

All tooling runs in disposable Docker containers — nothing needs to be
installed on the host.

First, tell the container which user to run as, so files it writes into the
working directory come out owned by you rather than by root:

```sh
printf 'DOCKER_UID=%s\nDOCKER_GID=%s\n' "$(id -u)" "$(id -g)" > .env
```

`.env` is gitignored and machine-local. Skipping this step is not cosmetic:
the container would fall back to uid 1000, and a mismatched uid leaves files
in the checkout that you cannot rewrite — which is how a root-owned
`package-lock.json` once broke `pre-commit`'s `end-of-file-fixer` and blocked
committing entirely. (Compose reads `DOCKER_UID` from the environment or
`.env`. Note bash's own `$UID` is a shell variable and is *not* exported, so
it will not reach Compose by itself.)

```sh
docker compose build dev
docker compose run --rm dev npm ci
docker compose run --rm dev npm run lint
docker compose run --rm dev npx tsc --noEmit
docker compose run --rm dev npm run build
```

npm's cache and Electron's ~100MB binary live in a named `cache` volume, so
they survive across the throwaway containers. If you ever change the container
user, remove the volumes so they are re-created with the new ownership —
`docker compose down -v` — since a named volume takes its permissions from the
image at first use and keeps them thereafter.

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

### Mapping the AI Mode DOM

The harvester is blocked on knowing the real page structure, and none of it
should be guessed. `scripts/recon-aimode.js` is a read-only probe for that:
open **Debug → Open AI Mode DevTools** while signed in and looking at your
conversation history, paste the script into that console, and it prints (and
copies) a JSON summary — candidate history controls, repeated `data-*`
attributes that could carry a stable thread id, conversation-looking links,
turn containers with their ancestor chains, and image hosts with their
lazy-loading attributes.

It assumes no selectors and clicks nothing. Chromium blocks the first paste
into a DevTools console; type `allow pasting` at the prompt once if it refuses.

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

To check the endpoint works at all:

```sh
docker compose run --rm -e NOTEBOOK_AI_MODE_URL=about:blank dev \
  xvfb-run -a scripts/smoke-devtools.sh 9222
```

It should list two `page` targets — the embedded panel and the app's own UI.
The `Failed to shutdown` line it prints at the end is the script killing
Electron, not a fault.

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

## Releasing

Releases are cut by [release-please](https://github.com/googleapis/release-please)
from Conventional Commit messages, so the version and changelog come from the
commit history rather than being edited by hand.

1. Merge work to `master` with conventional commit subjects (`feat:`, `fix:`,
   `feat!:` for breaking).
2. `release-please.yml` opens or updates a release PR, labelled `RELEASE` and
   colour-coded by bump type (green patch, yellow minor, orange major).
3. Merging that PR tags the release.
4. `release.yml` then builds the Windows installer on a `windows-latest`
   runner, publishes it to the GitHub release, and signs it with cosign.

On pull requests, `release-please-preview.yml` comments the version the PR
would produce, and `build.yml` attaches a Windows installer named for that
predicted version, with a download link commented on the PR.

Signing is **keyless**: cosign exchanges the job's GitHub OIDC token for a
short-lived Fulcio certificate and records the signature in the public Rekor
log, so no private key exists to hold or leak. To verify a downloaded
installer:

```sh
cosign verify-blob --bundle <installer>.cosign.bundle \
  --certificate-identity-regexp '^https://github.com/non7top/ai-chat-notebook/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  <installer>
```

Both the PR build and the release build run `npm run check:bundle` against the
packaged bundle. That guard exists because v0.1.0 shipped an installer that
could not start: electron-vite had externalized `electron-context-menu` to a
bare `require()`, and `electron-builder.yml` ships no `node_modules`. Lint,
type-check and running from a dev checkout all pass in that state — only the
installed app fails — so the check is the only thing standing between that
class of bug and a release.

### Known hurdles

Inherited from PromptLoom, where each was found the hard way — see
[../sprite-manager/README.md](../sprite-manager/README.md#build-tooling--known-hurdles):

- `release.yml` triggers on `workflow_run`, not `push: tags`. GitHub does not
  fire workflows for tags created with the default `GITHUB_TOKEN`, which is an
  anti-recursion guard, so a tag-triggered release workflow would simply never
  run.
- `publish.releaseType: release` is pinned in `electron-builder.yml`.
  electron-builder defaults to *draft* releases and silently skips every asset
  upload when a release of a different type already exists for the tag — which
  it always does here, since release-please created it first. The failure mode
  is a release with no installer attached and only a log line to show why.
- `release.yml` has a `workflow_dispatch` escape hatch to rebuild and publish
  an existing tag without waiting for a new release cycle. It deliberately
  builds from the dispatch ref rather than the tag, so a release-process fix
  actually takes effect instead of faithfully reproducing the broken build.

## Packaging

```sh
docker compose run --rm dev npm run make
```

That produces Linux deb/rpm. The Windows NSIS installer cannot be cross-built
from Linux — electron-builder cross-builds its deb and rpm targets happily, but
NSIS needs a real Windows host, so CI builds it on a `windows-latest` runner
(see `.github/workflows/build.yml`). There is no wine path here; use CI.

## Security notes

- The embedded panel holds a **live, logged-in Google session**, and the app's
  `userData` directory therefore holds Google session cookies alongside the
  archive.
- The renderer's CSP (in `index.html`) deliberately allows no remote image
  sources. If the asset-rewriting pass ever misses a URL, the image breaks
  visibly instead of silently re-fetching from Google every time an archived
  conversation is opened.
- HTML captured from Google is sanitised before it is ever stored or rendered.
