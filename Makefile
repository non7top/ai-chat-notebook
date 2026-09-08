# The documented way in. Every target is a disposable container over the
# committed compose file — nothing here depends on an image, container or volume
# that only exists because an earlier run created one.
#
# The uid/gid are passed through so bind-mounted writes land owned by whoever is
# driving this. bash's $UID is a shell variable and is NOT exported, so it cannot
# arrive by itself; that is what these two lines are for.
export DOCKER_UID := $(shell id -u)
export DOCKER_GID := $(shell id -g)

COMPOSE := docker compose
# Where the app is deployed. Overridable: make deploy DEST=/somewhere
DEST ?= /mnt/d
APP_DIR := $(DEST)/ai-chat-notebook

.PHONY: help image install install-dev install-win build lint typecheck check win win-dir deploy clean destroy

help:
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | expand -t22

image: ## Build the dev and wine images (cached; slow only the first time)
	$(COMPOSE) build dev win

# Split so `build` and `win` each depend only on the node_modules volume they
# actually read. Plain `npm install`, not `npm ci` — `ci` wipes and reinstalls
# node_modules from nothing every single time, even when the lockfile is
# already satisfied, which would turn every `make build`/`make win` into a
# full reinstall. `install` (below) is the human-facing "do both" entry point;
# `build`/`win` depend on the one-service targets directly so neither can run
# against a volume nothing has ever installed into (which is exactly how the
# win service first hit "a range cannot be resolved without electron installed
# in node_modules" — a fresh win_node_modules volume that `make win` had no
# dependency forcing it to populate).
install-dev: ## Install node_modules into the dev volume
	$(COMPOSE) run --rm dev npm install

install-win: ## Install node_modules into the win volume
	$(COMPOSE) run --rm win npm install

install: install-dev install-win ## Install node_modules into both named volumes

build: install-dev ## Bundle main, preload and renderer
	$(COMPOSE) run --rm dev npm run build

lint: ## Biome
	$(COMPOSE) run --rm dev npm run lint

typecheck: ## tsc --noEmit
	$(COMPOSE) run --rm dev npx tsc --noEmit

check: ## Every check script, the same set CI runs
	$(COMPOSE) run --rm dev npm run check:bundle
	$(COMPOSE) run --rm dev npm run check:sources
	$(COMPOSE) run --rm dev npm run check:recover
	$(COMPOSE) run --rm dev npm run check:inline
	$(COMPOSE) run --rm dev npm run check:sanitize
	$(COMPOSE) run --rm dev npm run check:counts
	$(COMPOSE) run --rm dev npm run check:find
	$(COMPOSE) run --rm dev npm run check:dates
	$(COMPOSE) run --rm dev npm run check:turns
	$(COMPOSE) run --rm dev npm run check:rewrite
	$(COMPOSE) run --rm dev npm run check:fingerprint
	$(COMPOSE) run --rm dev npm run check:cdp-proxy
	$(COMPOSE) run --rm dev npm run check:not-debug

win: build install-win ## Windows NSIS installer, via wine
	@# WINEPREFIX (Dockerfile.win) points at /cache/wine/prefix, a subdirectory
	@# that does not exist in a fresh win_cache volume — only its sticky-1777
	@# parent /cache/wine does, owned by root from the image. Pre-create the
	@# prefix dir ourselves (as this container's non-root user, same uid/gid as
	@# the host) so wine finds a directory it already owns instead of refusing
	@# with "'/cache/wine' is not owned by you, refusing to create a
	@# configuration directory there".
	$(COMPOSE) run --rm win sh -c 'mkdir -p "$$WINEPREFIX" && npx electron-builder --win --publish never'

win-dir: build ## Unpacked win32 folder — no wine, no installer, quickest
	@# signExecutable:false (not signAndEditExecutable:false) — the latter also
	@# skips icon/version-metadata editing, which is why the built exe used to
	@# report itself as "Electron" / "GitHub, Inc." in Windows file properties
	@# instead of this app's own name. No certificate is configured either way,
	@# so signing was always a no-op here; this only recovers the metadata.
	$(COMPOSE) run --rm dev npx electron-builder --win --dir --publish never \
		--config.win.signExecutable=false

deploy: win-dir ## Build and put the app at $(APP_DIR) — close the app first
	@# The staging directory is keyed on this process's pid, and that is not
	@# fussiness: two deploys running at once both used "$(APP_DIR).new", so one
	@# deleted the folder the other was still filling. The result passed every
	@# check the target made and left 27 of 74 files on the disk — an app that
	@# would start and then fail on a missing library. Concurrent runs now cannot
	@# see each other's staging.
	@stage="$(APP_DIR).stage-$$$$"; \
	rm -rf "$$stage" || exit 1; \
	cp -r dist/win-unpacked "$$stage" || { rm -rf "$$stage"; exit 1; }; \
	src=$$(find dist/win-unpacked -type f | wc -l); \
	dst=$$(find "$$stage" -type f | wc -l); \
	if [ "$$src" != "$$dst" ]; then \
		echo "copy came out $$dst of $$src files — leaving $(APP_DIR) as it was"; \
		rm -rf "$$stage"; exit 1; \
	fi; \
	if [ -d "$(APP_DIR)" ]; then \
		rm -rf "$$stage.old"; \
		mv "$(APP_DIR)" "$$stage.old" || { \
			echo "could not replace $(APP_DIR) — is the app still running?"; \
			rm -rf "$$stage"; exit 1; }; \
	fi; \
	mv "$$stage" "$(APP_DIR)" || { \
		echo "could not move the new build into place"; exit 1; }; \
	rm -rf "$$stage.old"; \
	echo "$(APP_DIR)  $$dst files  $$(du -sh "$(APP_DIR)" | cut -f1)  built $$(date +%H:%M)"

clean: ## Remove build output, keep the caches
	rm -rf dist out

destroy: ## Remove the containers AND the cached volumes
	$(COMPOSE) down -v
