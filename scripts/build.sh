#!/usr/bin/env bash
# Monorepo build script — handles cross-package deps via two-pass:
#   1. Clean all dist/ to remove stale artifacts
#   2. Emit .d.ts stubs for ALL packages (--emitDeclarationOnly --noCheck)
#   3. Full tsc build in topological order
#
# After ADR-001 cutover (Wave 9), packages are:
#   pyric           — modular SDK adapters + sandbox + rules (umbrella)
#   pyric-admin     — admin-shape adapters (umbrella)
#   pyric-tools     — CLI + deploy + bridge + discover + auth-config
#   @pyric/ui       — headless React components
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ── Helpers ─────────────────────────────────────────────────────────────

build_pkg() {
  local dir="$1"
  echo "▸ Building packages/$dir"
  rm -rf "packages/$dir/dist"
  bun run --cwd "packages/$dir" build
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
emit_stubs "pyric-tools"
emit_stubs "ui"

# ── Phase 2: Full build (topological order) ────────────────────────────
echo ""
echo "━━━ Phase 2: Full build ━━━"
build_pkg "pyric"
build_pkg "pyric-admin"
build_pkg "pyric-tools"
build_pkg "ui"

# ── Phase 3: Studio app (embedded into pyric-tools for `pyric dev --ui`) ──
# Built with base /__pyric/ui/ so its assets resolve under the CLI mount, then
# copied into pyric-tools' dist (which ships via the package `files: ["dist"]`).
# Runs after Phase 2: studio depends on `pyric` + `@pyric/ui`, and the copy
# target lives inside the already-built pyric-tools dist.
echo ""
echo "━━━ Phase 3: Studio app ━━━"
echo "▸ Building packages/studio (base /__pyric/ui/)"
rm -rf packages/studio/dist
STUDIO_BASE=/__pyric/ui/ bun run --cwd packages/studio build
echo "▸ Embedding studio app → packages/pyric-tools/dist/serve/studio-ui/"
rm -rf packages/pyric-tools/dist/serve/studio-ui
mkdir -p packages/pyric-tools/dist/serve/studio-ui
cp -R packages/studio/dist/app/. packages/pyric-tools/dist/serve/studio-ui/

echo ""
echo "━━━ Phase 4: Playground app ━━━"
echo "▸ Building packages/playground (base /__pyric/playground/)"
rm -rf packages/playground/dist
PLAYGROUND_BASE=/__pyric/playground/ bun run --cwd packages/playground build
echo "▸ Embedding playground app → packages/pyric-tools/dist/serve/playground-ui/"
rm -rf packages/pyric-tools/dist/serve/playground-ui
mkdir -p packages/pyric-tools/dist/serve/playground-ui
cp -R packages/playground/dist/client/. packages/pyric-tools/dist/serve/playground-ui/

echo ""
echo "✅ All packages built successfully"
