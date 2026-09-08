# ai-chat-notebook — working instructions

## Build locally, by preference rather than by necessity.

CI works again — verified 2026-09-08: `Build` and `Release` both succeeded on
`4621bab`, along with release-please and its preview. Between 2026-08-28 and then
every job on every workflow failed in about two seconds having run zero steps,
with the artifact store separately refusing uploads; that is over.

Build locally anyway. It is a forty-second loop against several minutes, it costs
no quota, and it does not depend on someone else's runner being willing. Use CI
for what only CI does — the release pipeline, and checks on a pull request.

The loop is local, in docker, through the Makefile:

    make win-dir     # the app, unpacked, as a folder — no wine, no installer
    make deploy      # copies that folder to /mnt/d/ai-chat-notebook

**`make win-dir` is what this project wants.** The NSIS installer (`make win`)
exists and works through wine, but installing is a step nobody needs here: the
unpacked folder is run directly, and it reads the same userData directory the
installed build does, so the archive carries over untouched.

Do not push a commit and then wait on CI for a binary you could have built here
in under a minute.

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
