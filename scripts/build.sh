#!/usr/bin/env bash
# Monorepo build script — handles cross-package deps via two-pass:
#   1. Clean all dist/ to remove stale artifacts
#   2. Emit .d.ts stubs for ALL packages (--emitDeclarationOnly --noCheck)
#   3. Full tsc build in topological order
#
# After ADR-001 cutover (Wave 9), packages are:
#   pyric           — modular SDK adapters + sandbox + rules (umbrella)
#   pyric-admin     — admin-shape adapters (umbrella)
#   create-pyric    — `npm create pyric` scaffolder (no Firebase SDK deps)
#   @pyric/cli      — CLI + bridge + discover + local sandbox tooling
#   @pyric/ui       — headless React components
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

BUILD_STUDIO=true
BUILD_DOCS=true
for arg in "$@"; do
  case "$arg" in
    --skip-docs)
      BUILD_DOCS=false
      ;;
    --packages-only)
      BUILD_STUDIO=false
      BUILD_DOCS=false
      ;;
    *)
      echo "Unknown build option: $arg" >&2
      exit 2
      ;;
  esac
done

# ── Helpers ─────────────────────────────────────────────────────────────

build_pkg() {
  local dir="$1"
  echo "▸ Building packages/$dir"
  rm -rf "packages/$dir/dist"
  if [ "$dir" = "cli" ]; then
    # emit_stubs already generated both ignored conformance projections from
    # the same checkout; package-local builds still run their normal prebuild.
    PYRIC_CONFORMANCE_READY=1 bun run --cwd "packages/$dir" build
  else
    bun run --cwd "packages/$dir" build
  fi
}

# Emit .d.ts stubs without type-checking
emit_stubs() {
  local dir="$1"
  echo "▸ Emitting stubs for packages/$dir"
  (cd "packages/$dir" && \
    if jq -e '.scripts.prebuild' package.json >/dev/null 2>&1; then
      bun run prebuild
    fi && \
    npx tsc --emitDeclarationOnly --noCheck)
}

# ── Phase 0: Clean all dist/ directories ───────────────────────────────
echo "━━━ Phase 0: Clean ━━━"
for dir in packages/*/; do
  if [ -d "${dir}dist" ]; then
    echo "  Cleaning ${dir}dist/"
    rm -rf "${dir}dist"
  fi
done

# ── Phase 1: Declaration stubs (all packages) ──────────────────────────
echo ""
echo "━━━ Phase 1: Declaration stubs ━━━"
emit_stubs "pyric"
emit_stubs "pyric-admin"
emit_stubs "create-pyric"
emit_stubs "ui"

# The CLI prebuild derives its ignored conformance projections from the live
# pyric export surface. Build that dependency before emitting CLI declarations
# so a clean checkout never needs a pre-existing runtime projection or dist.
echo "▸ Building packages/pyric for CLI conformance bootstrap"
build_pkg "pyric"
emit_stubs "cli"

# ── Phase 2: Full build (topological order) ────────────────────────────
echo ""
echo "━━━ Phase 2: Full build ━━━"
echo "▸ packages/pyric already built for the CLI conformance bootstrap"
build_pkg "pyric-admin"
build_pkg "create-pyric"
build_pkg "cli"
build_pkg "ui"

# ── Phase 3: Studio app (embedded into @pyric/cli for `pyric dev --ui`) ──
# Built with base /__pyric/ui/ so its assets resolve under the CLI mount, then
# copied into @pyric/cli's dist (which ships via the package `files: ["dist"]`).
# Runs after Phase 2: studio depends on `pyric` + `@pyric/ui`, and the copy
# target lives inside the already-built @pyric/cli dist.
echo ""
echo "━━━ Phase 3: Studio app ━━━"
if $BUILD_STUDIO; then
  echo "▸ Building packages/studio (base /__pyric/ui/)"
  rm -rf packages/studio/dist
  STUDIO_BASE=/__pyric/ui/ bun run --cwd packages/studio build
  echo "▸ Embedding studio app → packages/cli/dist/serve/studio-ui/"
  rm -rf packages/cli/dist/serve/studio-ui
  mkdir -p packages/cli/dist/serve/studio-ui
  cp -R packages/studio/dist/app/. packages/cli/dist/serve/studio-ui/
else
  echo "▸ Skipped for packages-only build"
fi

echo ""
echo "━━━ Phase 4: Docs site ━━━"
# Built with base /__pyric/ui/ so every doc page, asset, .md twin, index.json,
# and shell-chrome tab link resolves under the CLI mount: pages at
# /__pyric/ui/docs/<slug>/, assets at /__pyric/ui/_astro/*, the search index at
# /__pyric/ui/docs/index.json, and tabs back at /__pyric/ui/<tab>. The default
# (no DOCS_BASE) build the hosted site uses is unaffected — base stays `/`.
if $BUILD_DOCS; then
  echo "▸ Verifying generated API reference"
  bun run docs:api:check
  echo "▸ Building packages/site-docs (base /__pyric/ui/)"
  rm -rf packages/site-docs/dist
  DOCS_BASE=/__pyric/ui/ bun run --cwd packages/site-docs build
  echo "▸ Embedding docs site → packages/cli/dist/serve/docs-ui/"
  rm -rf packages/cli/dist/serve/docs-ui
  mkdir -p packages/cli/dist/serve/docs-ui
  cp -R packages/site-docs/dist/. packages/cli/dist/serve/docs-ui/
else
  echo "▸ Skipped for CI build profile"
fi

echo ""
echo "✅ All packages built successfully"
