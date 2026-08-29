# ai-chat-notebook — working instructions

## Build locally. Do not wait on GitHub Actions.

The account's Actions quota is exhausted: as of 2026-08-28 every job on every
workflow fails in about two seconds having run zero steps, while the artifact
store separately refuses uploads for lack of space. Nothing in this repo causes
it and nothing in this repo fixes it.

So the loop is local, in docker, through the Makefile:

    make win-dir     # the app, unpacked, as a folder — no wine, no installer
    make deploy      # copies that folder to /mnt/d/ai-chat-notebook

**`make win-dir` is what this project wants.** The NSIS installer (`make win`)
exists and works through wine, but installing is a step nobody needs here: the
unpacked folder is run directly, and it reads the same userData directory the
installed build does, so the archive carries over untouched.

Do not push a commit and then watch CI for a binary. There will not be one.

## Deploying

`make deploy` puts the app at **`/mnt/d/ai-chat-notebook`** (that is `D:\ai-chat-notebook`
from Windows) and runs `AIChatNotebook.exe` from there.

Windows holds the executable open while the app is running, so **close the app
before deploying** — the swap fails otherwise, and the target says so rather than
leaving a half-copied folder.

## Checks before handing anything over

    make lint typecheck check

`make check` runs the same thirteen check scripts CI used to. Losing the runner
loses none of them.

## Caches

Everything expensive lives in named volumes and survives `docker compose down`:
npm, the per-platform Electron zip, electron-builder's nsis/winCodeSign/app-builder
downloads, and the wine prefix. `make destroy` removes them deliberately; a
missing cache is a slow path, never a broken one.

## Measuring the running app

The app exposes a debugging port behind a Basic-auth proxy (default `ai:ai`).
`docker compose run --rm recon node scripts/cdp-eval.mjs --match=notebook
--auth=ai:ai '<expression>'` reads the app's own renderer; `--match=google` reads
the embedded panel. The `recon` service exists for this and shares the host's
network namespace, which is the only way to reach a port on the host's loopback.

Read the archive with a read-only handle on the live sqlite file rather than
copying it — it is over 1.5GB, and a copy has already filled the scratch disk and
truncated a script to zero bytes.

## What not to read

Do not read the user's conversations. Measurements are counts, ids, lengths,
timestamps and DOM shapes — never prompts, answers, or titles beyond what is
needed to match something the user has already quoted.
