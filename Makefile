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

.PHONY: help image install build lint typecheck check win win-dir deploy clean destroy

help:
	@grep -E '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) | sed 's/:.*## /\t/' | expand -t22

image: ## Build the dev and wine images (cached; slow only the first time)
	$(COMPOSE) build dev win

install: ## Install node_modules into the named volumes
	$(COMPOSE) run --rm dev npm install
	$(COMPOSE) run --rm win npm install

build: ## Bundle main, preload and renderer
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

win: build ## Windows NSIS installer, via wine
	$(COMPOSE) run --rm win npx electron-builder --win --publish never

win-dir: build ## Unpacked win32 folder — no wine, no installer, quickest
	$(COMPOSE) run --rm dev npx electron-builder --win --dir --publish never \
		--config.win.signAndEditExecutable=false

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
