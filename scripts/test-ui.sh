#!/usr/bin/env bash
# Browser test for `factory ui` in Playwright's own image, so no browser or system libraries are
# needed on this machine (WSL can't install them without sudo). Only Docker, which the factory
# needs anyway. Usage: npm run test:ui        (tests)
#                      npm run screens        (also writes docs/screens/*.jpg)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('@playwright/test/package.json').version")
mounts=(-v "$PWD:$PWD")
# a worktree may link node_modules from the main checkout: mount that too
if [ -L node_modules ]; then real=$(readlink -f node_modules); mounts+=(-v "$real:$real:ro"); fi
exec docker run --rm --network host --user "$(id -u):$(id -g)" -e HOME=/tmp -e SCREENS="${SCREENS:-}" \
  "${mounts[@]}" -w "$PWD" "mcr.microsoft.com/playwright:v${VERSION}-noble" npx playwright test "$@"
