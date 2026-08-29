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
# Where a finished installer is dropped. Overridable: make win DEST=/somewhere
DEST ?= /mnt/d/tmp

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

deploy: ## Copy the newest installer to DEST (default D:\tmp)
	@exe=$$(ls -t dist/*.exe 2>/dev/null | head -1); \
	if [ -z "$$exe" ]; then echo "no installer in dist/ — run make win first"; exit 1; fi; \
	cp "$$exe" "$(DEST)/"; \
	echo "$(DEST)/$$(basename $$exe)  $$(stat -c%s "$$exe") bytes  md5 $$(md5sum < "$$exe" | cut -d' ' -f1)"

clean: ## Remove build output, keep the caches
	rm -rf dist out

destroy: ## Remove the containers AND the cached volumes
	$(COMPOSE) down -v
