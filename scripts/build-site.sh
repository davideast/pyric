#!/usr/bin/env bash
# Composed static Pyric Studio site build. See scripts/site/build.ts for the
# actual driver (Studio + SDK/worker bundles + playground static client +
# demo seed + docs/llms.txt placeholders → dist/site/).
#
# Prereq: `bun run build` (root) must have already built @pyric/cli' dist/ —
# the SDK/worker bundler is imported directly from
# packages/cli/dist/serve/bundler.js, not through a running server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bun run scripts/site/build.ts "$@"
