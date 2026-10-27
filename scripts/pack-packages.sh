#!/usr/bin/env bash
# Pack every published Pyric package into `dist/packages/` for manual
# testing, side-by-side comparison, or local-install workflows.
#
# Output: `dist/packages/<name>-<version>.tgz` (npm's default tarball
# naming, scoped names flattened — e.g. `@pyric/ui` → `pyric-ui-0.1.0-alpha.7.tgz`).
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
#         bash scripts/pack-packages.sh --skip-build --out <dir>
#         npm run pack
#
# This is the one place tarballs are made. The packaging gate
# (scripts/packaging-test.sh), the release smoke, the app scenarios and
# publish-alpha.sh all use the tarballs it writes.

set -euo pipefail

# macOS adds AppleDouble entries for extended attributes unless this is set.
# Those entries become visible package files when npm publishes a tarball.
export COPYFILE_DISABLE=1

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/dist/packages"

SKIP_BUILD=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --out) OUT_DIR="${2:?--out needs a directory}"; shift 2 ;;
    *) echo "pack-packages: unknown argument $1 (takes --skip-build and --out <dir>)" >&2; exit 2 ;;
  esac
done
case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$PWD/$OUT_DIR" ;;
esac

# Packages to ship. Listed in dependency order (dependencies first) for
# readability; the actual pack order does not matter since each tarball
# is self-contained after the workspace:* rewrite.
PACKAGES=(
  "packages/pyric"
  "packages/pyric-admin"
  "packages/create-pyric"
  "packages/cli"
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

# The npm-facing README for the core packages is the root README. Each package
# keeps its own README.md in the source tree. Replace the README only inside the
# extracted tarball so packing never mutates the working tree.
ROOT_README_PACKAGES=("pyric" "pyric-admin" "@pyric/cli")

uses_root_readme() {
  local name="$1"
  for n in "${ROOT_README_PACKAGES[@]}"; do
    [ "$n" = "$name" ] && return 0
  done
  return 1
}

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

  # Post-process the extracted package once when it needs the root README or
  # concrete workspace dependency versions, and check its source maps either way.
  # Do not use `grep -q` here. GNU tar reports SIGPIPE when grep exits after
  # the first match; with `pipefail` that makes the condition falsely report
  # that the manifest contains no workspace dependency.
  local has_workspace_deps=0
  if tar -xzOf "$full" package/package.json | grep 'workspace:' >/dev/null; then
    has_workspace_deps=1
  fi
  local tmp
  tmp=$(mktemp -d)
  tar -xzf "$full" -C "$tmp"
  if uses_root_readme "$name" || [ "$has_workspace_deps" -eq 1 ]; then
    if uses_root_readme "$name"; then
      cp "$ROOT/README.md" "$tmp/package/README.md"
      echo "    (README: root README added to npm tarball)"
    fi
    if [ "$has_workspace_deps" -eq 1 ]; then
      node "$ROOT/scripts/lib/rewrite-workspace-deps.mjs" \
        "$tmp/package/package.json" "$ROOT"
    fi
    (cd "$tmp" && tar -czf "$full" package)
  fi
  # Every source map the tarball ships must resolve to sources it also ships.
  node "$ROOT/scripts/lib/verify-published-sourcemaps.mjs" "$tmp/package"
  rm -rf "$tmp"

  # Verification: no `workspace:` may survive into the shipped tarball.
  if tar -xzOf "$full" package/package.json | grep -nE '"workspace:'; then
    echo "  ✗ $name tarball still contains workspace: deps after rewrite" >&2
    echo "    (see lines above; fix scripts/lib/rewrite-workspace-deps.mjs)" >&2
    exit 1
  fi

  local size
  size=$(du -h "$full" | awk '{print $1}')
  echo "    → $full ($size)"
}

for pkg_dir in "${PACKAGES[@]}"; do
  pack_one "$pkg_dir"
done

# ─── Phase 3: write a manifest ─────────────────────────────────────────
echo ""
echo "━━━ Phase 3: manifest ━━━"

node "$ROOT/scripts/lib/package-artifact-manifest.mjs" \
  "$ROOT" "$OUT_DIR" "${PACKAGES[@]}"

# ─── Phase 4: report ───────────────────────────────────────────────────
echo ""
echo "━━━ Phase 4: report ━━━"
echo ""
ls -lh "$OUT_DIR" | tail -n +2 | awk '{print "  " $9 "  " $5}'

echo ""
echo "✓ All 5 publishable packages packed into $OUT_DIR/"
echo ""
echo "See $OUT_DIR/manifest.json for exact tarball filenames."
