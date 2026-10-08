# Monochrome Unicorn -- a web app for Zebra thermal printers.
# Copyright (C) 2026 Tyler Whittaker
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# Shortcuts for the scripts in this repository; each target says what it
# runs, and `make` alone lists them.
#
#   make deploy IP=192.168.1.81
#   make test-live ARGS="--only editor,files --no-deploy"
#
# IP defaults to the printer in test/live/config.json, when there is one.
# PRINTERS is the set `make deploy-all` installs on -- the same two the
# post-commit hook deploys to.

IP ?= $(shell node -p "try { require('./test/live/config.json').ip || '' } catch { '' }" 2>/dev/null)
PRINTERS ?= 192.168.1.220 192.168.1.81
ARGS ?=

.DEFAULT_GOAL := help
.PHONY: help install build build-packed deploy deploy-quick deploy-packed deploy-all \
        schema test test-live \
        test-live-quick format format-check check lcd-helper lcd-shot version \
        bump-patch bump-minor bump-major release clean need-ip

help: ## list the targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@echo
	@echo "  IP=$(if $(IP),$(IP),<unset>)  PRINTERS=$(PRINTERS)"

need-ip:
	@test -n "$(IP)" || { echo "Set the printer: make $(MAKECMDGOALS) IP=<printer-ip>" >&2; exit 2; }

install: ## install the dev dependencies and the git hooks
	npm install

build: ## build dist/INDEX.SHTML without touching a printer
	node tools/build.mjs

build-packed: ## the same, gzipped: ~170 KB for a slow link (Safari 16.4+, Firefox 113+)
	node tools/build.mjs --packed

deploy: need-ip ## read the printer's catalogue, build and install on IP
	./deploy.sh $(IP)

deploy-quick: need-ip ## build and install on IP, reusing data/sgd-schema.json
	./deploy.sh $(IP) --no-schema

deploy-packed: need-ip ## install the packed page on IP (the next commit's deploy unpacks it again)
	./deploy.sh $(IP) --no-schema --packed

deploy-all: ## build and install on every printer in PRINTERS
	@for p in $(PRINTERS); do echo "== $$p"; ./deploy.sh $$p || exit 1; done

schema: need-ip ## capture IP's settings catalogue into data/sgd-schema.json
	node tools/fetch-schema.mjs $(IP)

test: ## the unit tests: no printer needed
	npm test

test-live: ## every mode, in Chrome, against a real printer (asks first)
	node test/live/run.mjs $(if $(IP),--ip $(IP)) $(ARGS)

test-live-quick: ## the live tests from the config file, without deploying or asking
	node test/live/run.mjs --yes --no-deploy $(if $(IP),--ip $(IP)) $(ARGS)

format: ## lay out every .js/.mjs with prettier
	npm run format

format-check: ## fail if prettier would change anything
	npm run format:check

check: format-check test build ## what should pass before a commit

lcd-helper: need-ip ## mirror IP's real LCD to the LCD Viewer (Ctrl-C stops)
	./lcd_display_helper.sh $(IP)

lcd-shot: need-ip ## save IP's front panel as lcd.png
	node tools/lcd-shot.mjs $(IP)

version: ## print the version
	@node tools/version.mjs

bump-patch: ## move the version on: a fix
	node tools/version.mjs bump patch

bump-minor: ## move the version on: a feature
	node tools/version.mjs bump minor

bump-major: ## move the version on: something that breaks
	node tools/version.mjs bump major

# The release is the committed source (HEAD), as git archive gives it:
# no .git, node_modules, build output or untracked files, and not the
# Zebra reference material, the original prompt or AGENTS.md (a symlink
# to README.md). Named <package name>-<version>.tar.gz, unpacking into a
# directory of the same name, the version read from HEAD's package.json.
RELEASE_EXCLUDE = ':(exclude)reference' ':(exclude)docs/initial_claude_prompt.txt' \
                  ':(exclude)AGENTS.md'

release: ## dist/<name>-<version>.tar.gz of the committed source
	@name=$$(git show HEAD:package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).name") && \
	version=$$(git show HEAD:package.json | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).version") && \
	out=dist/$$name-$$version.tar.gz && mkdir -p dist && \
	{ git diff --quiet HEAD -- || echo "note: uncommitted changes are not in it; it is made from HEAD" >&2; } && \
	git archive --format=tar.gz --prefix=$$name-$$version/ -o $$out HEAD -- . $(RELEASE_EXCLUDE) && \
	echo "$$out  $$(tar -tzf $$out | grep -vc '/$$') files, $$(du -h $$out | cut -f1)"

clean: ## remove the build output and the LCD helper's files
	rm -rf dist lcd.bmp lcd.bmp.part lcd.png
