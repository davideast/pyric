#!/usr/bin/env bash
# Pack every published Pyric package (or `@pyric/rules` alone with
# `--package rules`) into `dist/packages/` for manual testing, side-by-side
# comparison, or release workflows.
#
# Output: `dist/packages/<name>-<version>.tgz` (npm's default tarball
# naming, scoped names flattened -- e.g. `@pyric/ui` -> `pyric-ui-0.1.0-alpha.7.tgz`).
#
# Default behavior: rebuilds before packing so dist/ is fresh. Pass
# `--skip-build` to pack the current dist/ contents.
#
# `workspace:*` deps are rewritten to concrete version refs in each packed
# tarball via scripts/lib/rewrite-workspace-deps.mjs. npm does not rewrite
# them on pack (pnpm does); leaving them literal would trip
# `EUNSUPPORTEDPROTOCOL` in any downstream `npm install`.
#
# After rewrite we VERIFY no `workspace:` remains -- load-bearing safety
# net so a future rewriter bug cannot ship a broken manifest to consumers.
#
# Run as: bash scripts/pack-packages.sh
#         bash scripts/pack-packages.sh --package rules
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
PACKAGE_TARGET="pyric"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --out) OUT_DIR="${2:?--out needs a directory}"; shift 2 ;;
    --package) PACKAGE_TARGET="${2:?--package needs pyric or rules}"; shift 2 ;;
    --package=*) PACKAGE_TARGET="${1#--package=}"; shift ;;
    *) echo "pack-packages: unknown argument $1 (takes --package pyric|rules, --skip-build, and --out <dir>)" >&2; exit 2 ;;
  esac
done

case "$PACKAGE_TARGET" in
  pyric) ;;
  rules|@pyric/rules) PACKAGE_TARGET="rules" ;;
  *) echo "pack-packages: unknown --package '$PACKAGE_TARGET' (expected pyric or rules)" >&2; exit 2 ;;
esac

case "$OUT_DIR" in
  /*) ;;
  *) OUT_DIR="$PWD/$OUT_DIR" ;;
esac

# Unless the pack finishes, it leaves no tarball behind: a failure (the build,
# npm pack, a check on a tarball, the manifest) or an interrupt (SIGINT,
# SIGTERM, SIGHUP) clears the outputs, so nothing a check refused, and no
# older pack, can be mistaken for this pack's output.
clear_outputs() {
  rm -f "$OUT_DIR"/*.tgz "$OUT_DIR/manifest.json" "$OUT_DIR/proven.json"
}
PACKED=0
trap 'if [ "$PACKED" -ne 1 ]; then clear_outputs; echo "pack-packages: did not finish; removed the tarballs in $OUT_DIR" >&2; fi' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# The tree this pack builds from, before the build: proven-stamp.mjs records
# it with the tarballs' hashes, and a later stamp must still match it.
PACK_HEAD="$(git -C "$ROOT" rev-parse HEAD)"
PACK_CLEAN=true
if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=all --ignore-submodules=none)" ]; then
  PACK_CLEAN=false
fi

# Packages to ship. Listed in dependency order (dependencies first) for
# readability; `--package rules` packs `@pyric/rules` alone on its own release line.
if [ "$PACKAGE_TARGET" = "rules" ]; then
  PACKAGES=(
    "packages/rules"
  )
else
  PACKAGES=(
    "packages/rules"
    "packages/pyric"
    "packages/pyric-admin"
    "packages/create-pyric"
    "packages/cli"
    "packages/ui"
    "packages/live"
  )
fi

# --- Phase 0: optional rebuild -----------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "=== Phase 0: build ==="
  cd "$ROOT"
  if [ "$PACKAGE_TARGET" = "rules" ]; then
    rm -rf "$ROOT/packages/rules/dist"
    bun run --cwd "$ROOT/packages/rules" build
  else
    bash scripts/build.sh
  fi
else
  echo "=== Phase 0: skipped (--skip-build) ==="
fi

# --- Phase 1: prep output dir ------------------------------------------
echo ""
echo "=== Phase 1: prep $OUT_DIR ==="
# Clear every tarball, the manifest and the proven.json stamp, never the
# directory or its other files. A new pack is unproven until publish-alpha.sh
# stamps it again.
mkdir -p "$OUT_DIR"
clear_outputs

# --- Phase 2: pack each package ----------------------------------------
echo ""
echo "=== Phase 2: pack ==="

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

# Repack an extracted `package/` directory into a byte-deterministic `.tgz`:
# lexicographically sorted paths, fixed mtime (1985-10-26T08:15:00Z, matching
# npm pack), uid/gid 0 with empty uname/gname, normalized 0644/0755 modes
# independent of caller umask, and normalized gzip header (mtime=0, OS=0xff).
# Implemented in Node so Linux GNU tar and macOS bsdtar produce identical bytes.
repack_deterministic() {
  local package_dir="$1"
  local out_tgz="$2"
  node - "$package_dir" "$out_tgz" <<'NODE'
const { lstatSync, readdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { gzipSync } = require('node:zlib');

const FIXED_MTIME = 499162500;

function collectFiles(dir, relPrefix, out) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = `${relPrefix}/${entry.name}`;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw new Error(`refusing symbolic link in packed tarball: ${rel}`);
    }
    if (st.isDirectory()) {
      collectFiles(abs, rel, out);
    } else if (st.isFile()) {
      const mode = (st.mode & 0o100) !== 0 ? 0o755 : 0o644;
      out.push({ abs, rel, mode });
    } else {
      throw new Error(`unsupported entry type in packed tarball: ${rel}`);
    }
  }
}

function writeOctal(header, offset, width, value) {
  const digits = value.toString(8).padStart(width - 1, '0');
  if (digits.length > width - 1) {
    throw new Error(`tar field overflow for value ${value} at offset ${offset}`);
  }
  header.write(`${digits}\0`, offset, width, 'ascii');
}

function splitUstarPath(relPath) {
  if (Buffer.byteLength(relPath, 'utf8') <= 100) {
    return { name: relPath, prefix: '' };
  }
  for (let idx = relPath.indexOf('/'); idx !== -1; idx = relPath.indexOf('/', idx + 1)) {
    const prefix = relPath.slice(0, idx);
    const name = relPath.slice(idx + 1);
    if (
      prefix.length > 0 &&
      name.length > 0 &&
      Buffer.byteLength(prefix, 'utf8') <= 155 &&
      Buffer.byteLength(name, 'utf8') <= 100
    ) {
      return { name, prefix };
    }
  }
  return null;
}

function buildPaxRecord(key, value) {
  const suffix = ` ${key}=${value}\n`;
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');
  let length = String(suffixBytes).length + suffixBytes;
  while (String(length).length + suffixBytes !== length) {
    length = String(length).length + suffixBytes;
  }
  return Buffer.from(`${length}${suffix}`, 'utf8');
}

function buildHeader(name, prefix, mode, size, typeflag) {
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, Math.min(100, Buffer.byteLength(name, 'utf8')), 'utf8');
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, FIXED_MTIME);
  header.fill(0x20, 148, 156);
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  writeOctal(header, 329, 8, 0);
  writeOctal(header, 337, 8, 0);
  if (prefix.length > 0) {
    header.write(prefix, 345, Math.min(155, Buffer.byteLength(prefix, 'utf8')), 'utf8');
  }
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return header;
}

function appendBlock(chunks, header, body) {
  chunks.push(header);
  if (body.length > 0) {
    chunks.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
}

const [packageDir, outTgz] = process.argv.slice(2);
const files = [];
collectFiles(packageDir, 'package', files);
files.sort((a, b) => {
  if (a.rel < b.rel) return -1;
  if (a.rel > b.rel) return 1;
  return 0;
});
const chunks = [];
for (const file of files) {
  const body = readFileSync(file.abs);
  const split = splitUstarPath(file.rel);
  if (split !== null) {
    appendBlock(chunks, buildHeader(split.name, split.prefix, file.mode, body.length, '0'), body);
  } else {
    const paxBody = buildPaxRecord('path', file.rel);
    const fallbackName = file.rel.slice(-99).replace(/^\/+/, '');
    appendBlock(chunks, buildHeader(`PaxHeader/${fallbackName}`.slice(0, 100), '', 0o644, paxBody.length, 'x'), paxBody);
    appendBlock(chunks, buildHeader(fallbackName, '', file.mode, body.length, '0'), body);
  }
}
chunks.push(Buffer.alloc(1024, 0));
const gz = gzipSync(Buffer.concat(chunks), { level: 9 });
gz[4] = 0;
gz[5] = 0;
gz[6] = 0;
gz[7] = 0;
gz[9] = 0xff;
writeFileSync(outTgz, gz);
NODE
}

pack_one() {
  local pkg_dir="$1"
  local name
  name=$(jq -r '.name' "$ROOT/$pkg_dir/package.json")
  local version
  version=$(jq -r '.version' "$ROOT/$pkg_dir/package.json")
  echo "> packing $name@$version"

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
  if uses_root_readme "$name"; then
    cp "$ROOT/README.md" "$tmp/package/README.md"
    echo "    (README: root README added to npm tarball)"
  fi
  if [ "$has_workspace_deps" -eq 1 ]; then
    node "$ROOT/scripts/lib/rewrite-workspace-deps.mjs" \
      "$tmp/package/package.json" "$ROOT"
  fi
  # Every source map the tarball ships must resolve to sources it also ships.
  node "$ROOT/scripts/lib/verify-published-sourcemaps.mjs" "$tmp/package"
  repack_deterministic "$tmp/package" "$full"
  rm -rf "$tmp"

  # Verification: no `workspace:` may survive into the shipped tarball.
  if tar -xzOf "$full" package/package.json | grep -nE '"workspace:'; then
    echo "  x $name tarball still contains workspace: deps after rewrite" >&2
    echo "    (see lines above; fix scripts/lib/rewrite-workspace-deps.mjs)" >&2
    exit 1
  fi

  local size
  size=$(du -h "$full" | awk '{print $1}')
  echo "    -> $full ($size)"
}

for pkg_dir in "${PACKAGES[@]}"; do
  pack_one "$pkg_dir"
done

# --- Phase 3: write a manifest -----------------------------------------
echo ""
echo "=== Phase 3: manifest ==="

node "$ROOT/scripts/lib/package-artifact-manifest.mjs" \
  "$ROOT" "$OUT_DIR" "${PACKAGES[@]}"
# Each tarball's sha256 as written here, and the tree it came from.
node "$ROOT/scripts/lib/proven-stamp.mjs" record "$OUT_DIR" "$ROOT" "$PACK_HEAD" "$PACK_CLEAN"

# --- Phase 4: report ---------------------------------------------------
echo ""
echo "=== Phase 4: report ==="
echo ""
ls -lh "$OUT_DIR" | tail -n +2 | awk '{print "  " $9 "  " $5}'

echo ""
echo "ok All ${#PACKAGES[@]} packages packed into $OUT_DIR/"
echo ""
echo "See $OUT_DIR/manifest.json for exact tarball filenames."

PACKED=1
