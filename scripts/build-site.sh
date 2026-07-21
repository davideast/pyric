#!/usr/bin/env bash
# Public unified Astro-site build. The driver builds Studio + documentation
# from packages/site-docs, adds the SDK/SharedWorker and curated demo seed,
# then stamps the finite Studio entry pages with the worker generation.
#
# Prereq: `bun run build` (root) must have already built @pyric/cli's dist/ —
# the SDK/worker bundler is imported directly from
# packages/cli/dist/serve/bundler.js, not through a running server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

bun run scripts/site/build.ts "$@"
