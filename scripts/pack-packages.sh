#!/usr/bin/env bash
# Pack every published Pyric package into `dist/packages/` for manual
# testing, side-by-side comparison, or local-install workflows.
#
# Output: `dist/packages/<name>-<version>.tgz` (npm's default tarball
# naming, scoped names flattened — e.g. `@pyric/ui` → `pyric-ui-0.0.0.tgz`).
#
# Default behavior: rebuilds before packing so dist/ is fresh. Pass
# `--skip-build` to pack the current dist/ contents (useful when
# iterating).
#
# `workspace:*` deps are rewritten to `^<version-of-target-workspace>`
# in each packed tarball via scripts/lib/rewrite-workspace-deps.mjs. npm
# does not rewrite them on pack (pnpm does); leaving them literal would
# trip `EUNSUPPORTEDPROTOCOL` in any downstream `npm install`. Rewriting
# to `*` would resolve "any version" — also dangerous. Concrete version
# refs are the only safe shape.
#
# After rewrite we VERIFY no `workspace:` remains — load-bearing safety
# net so a future rewriter bug can't ship a broken manifest to consumers.
#
# Run as: bash scripts/pack-packages.sh
#         bash scripts/pack-packages.sh --skip-build
#         npm run pack

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist/packages"

SKIP_BUILD=0
if [ "${1:-}" = "--skip-build" ]; then
  SKIP_BUILD=1
fi

# Packages to ship. Listed in dependency order (dependencies first) for
# readability; the actual pack order does not matter since each tarball
# is self-contained after the workspace:* rewrite.
PACKAGES=(
  "packages/pyric"
  "packages/pyric-admin"
  "packages/pyric-tools"
  "packages/ui"
)

# ─── Phase 0: optional rebuild ─────────────────────────────────────────
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "━━━ Phase 0: build ━━━"
  cd "$ROOT"
  bash scripts/build.sh
else
  echo "━━━ Phase 0: skipped (--skip-build) ━━━"
fi

# ─── Phase 1: prep output dir ──────────────────────────────────────────
echo ""
echo "━━━ Phase 1: prep dist/packages/ ━━━"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# ─── Phase 2: pack each package ────────────────────────────────────────
echo ""
echo "━━━ Phase 2: pack ━━━"

pack_one() {
  local pkg_dir="$1"
  local name
  name=$(jq -r '.name' "$ROOT/$pkg_dir/package.json")
  local version
  version=$(jq -r '.version' "$ROOT/$pkg_dir/package.json")
  echo "▸ packing $name@$version"

  # npm pack writes <flattened-name>-<version>.tgz (scope removed,
  # `/` replaced by `-`). Capture the produced filename via npm's
  # stdout output.
  local tarball
  tarball=$(cd "$ROOT/$pkg_dir" && npm pack --silent --pack-destination "$OUT_DIR")
  local full="$OUT_DIR/$tarball"

  # Post-process: rewrite workspace:* → ^<version> via the shared helper
  # so the tarball is installable by any non-workspace consumer.
  if tar -xzOf "$full" package/package.json | grep -q 'workspace:'; then
    local tmp
    tmp=$(mktemp -d)
    tar -xzf "$full" -C "$tmp"
    node "$ROOT/scripts/lib/rewrite-workspace-deps.mjs" \
      "$tmp/package/package.json" "$ROOT"
    (cd "$tmp" && tar -czf "$full" package)
    rm -rf "$tmp"
  fi

  # Verification: no `workspace:` may survive into the shipped tarball.
  if tar -xzOf "$full" package/package.json | grep -nE '"workspace:'; then
    echo "  ✗ $name tarball still contains workspace: deps after rewrite" >&2
    echo "    (see lines above; fix scripts/lib/rewrite-workspace-deps.mjs)" >&2
    exit 1
  fi

  local size
  size=$(du -h "$full" | awk '{print $1}')
  echo "    → dist/packages/$tarball ($size)"
}

for pkg_dir in "${PACKAGES[@]}"; do
  pack_one "$pkg_dir"
done

# ─── Phase 3: write a manifest ─────────────────────────────────────────
echo ""
echo "━━━ Phase 3: manifest ━━━"

node -e "
const fs = require('fs');
const path = require('path');
const root = '$ROOT';
const out = '$OUT_DIR';
const packages = $(printf '%s\n' "${PACKAGES[@]}" | jq -R . | jq -s .);
const manifest = {
  generated: new Date().toISOString(),
  packages: packages.map((dir) => {
    const pj = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf-8'));
    const flat = pj.name.replace(/^@/, '').replace(/\//g, '-');
    const file = flat + '-' + pj.version + '.tgz';
    const fullPath = path.join(out, file);
    return {
      name: pj.name,
      version: pj.version,
      tarball: 'dist/packages/' + file,
      bytes: fs.statSync(fullPath).size,
      sourceDir: dir,
      subpaths: pj.exports ? Object.keys(pj.exports).sort() : [],
      bin: pj.bin ? Object.keys(pj.bin) : [],
    };
  }),
};
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('    → dist/packages/manifest.json (' + manifest.packages.length + ' packages)');
"

# ─── Phase 4: report ───────────────────────────────────────────────────
echo ""
echo "━━━ Phase 4: report ━━━"
echo ""
ls -lh "$OUT_DIR" | tail -n +2 | awk '{print "  " $9 "  " $5}'

echo ""
echo "✓ All 4 publishable libraries packed into dist/packages/"
echo ""
echo "See $OUT_DIR/manifest.json for exact tarball filenames."
