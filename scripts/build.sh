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

BUILD_SITE=true
for arg in "$@"; do
  case "$arg" in
    --packages-only)
      BUILD_SITE=false
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
build_pkg "studio"

# ── Phase 3: Unified Astro site (embedded into @pyric/cli) ─────────────
# One build owns Studio entry pages, docs, and their shared asset graph. It is
# rooted at /__pyric/ui/ for the CLI host and copied as one site-ui tree.
echo ""
echo "━━━ Phase 3: Astro site ━━━"
if $BUILD_SITE; then
  echo "▸ Building packages/site-docs (base /__pyric/ui/)"
  rm -rf packages/site-docs/dist
  DOCS_BASE=/__pyric/ui/ bun run --cwd packages/site-docs build
  echo "▸ Embedding Astro site → packages/cli/dist/serve/site-ui/"
  rm -rf packages/cli/dist/serve/site-ui
  mkdir -p packages/cli/dist/serve/site-ui
  cp -R packages/site-docs/dist/. packages/cli/dist/serve/site-ui/
else
  echo "▸ Skipped for packages-only build"
fi

echo ""
echo "✅ All packages built successfully"
