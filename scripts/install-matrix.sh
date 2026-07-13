#!/usr/bin/env bash
# Install + subpath-resolution matrix for ONE package manager.
#
# Package managers resolve `exports`, scoped names, and local tarballs with
# meaningfully different algorithms (npm's hoisting vs pnpm's strict symlinked
# store vs bun's layout). A package that resolves cleanly under npm can fail under
# pnpm/bun — so the publishable libs are installed from their REAL tarballs,
# every advertised subpath is imported, and the installed CLI is executed under
# each manager in turn.
#
# This is the resolution-portability leg; the full runtime/serve/contract proof
# lives in scripts/packaging-test.sh (npm). Peer deps (react/react-dom/firebase)
# are installed explicitly so we test OUR exports resolution apples-to-apples, not
# each manager's peer-install policy.
#
# Usage: bash scripts/install-matrix.sh <npm|pnpm|bun>
set -euo pipefail

PM="${1:?usage: install-matrix.sh <npm|pnpm|bun>}"
case "$PM" in npm|pnpm|bun) ;; *) echo "unknown package manager: $PM" >&2; exit 2 ;; esac
command -v "$PM" >/dev/null 2>&1 || { echo "✗ $PM is not installed" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "━━━ install matrix: $PM ($("$PM" --version 2>/dev/null | head -1)) ━━━"

# 1. The real publish artifacts (rewritten workspace:* → ^version). Build+pack if
#    they aren't already present (CI builds first, then runs the matrix).
if [ ! -f dist/packages/manifest.json ]; then
  echo "▸ packing publishable libraries (npm run pack)…"
  bash scripts/pack-packages.sh >/dev/null
fi

TARBALLS=()
while IFS= read -r tb; do
  TARBALLS+=("$tb")
done < <(node -e "
const path = require('path');
const manifest = require(path.join(process.cwd(), 'dist/packages/manifest.json'));
const names = ['pyric', 'pyric-admin', 'create-pyric', '@pyric/cli', '@pyric/ui'];
for (const name of names) {
  const entry = manifest.packages.find((p) => p.name === name);
  if (!entry) {
    console.error('missing package in dist/packages/manifest.json: ' + name);
    process.exit(1);
  }
  console.log(path.join(process.cwd(), entry.tarball));
}
")
for tb in "${TARBALLS[@]}"; do
  [ -f "$tb" ] || { echo "✗ missing tarball $tb (run: npm run pack)" >&2; exit 1; }
done

# 2. Fresh consumer. The five packages are declared as `file:` tarball deps, and the
#    SAME local tarballs are pinned via every manager's override channel
#    (overrides / resolutions / pnpm.overrides). Without this, the inter-package
#    deps can resolve differently per manager. Pinning makes the matrix test OUR
#    exports resolution apples-to-apples, not registry availability. (peers:
#    react/react-dom for @pyric/ui, firebase for the SDKs.)
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"
CONSUMER_DIR="$CONSUMER" node -e '
const fs = require("fs");
const path = require("path");
const dir = process.env.CONSUMER_DIR;
const [pyric, admin, create, tools, ui] = process.argv.slice(1).map((p) => "file:" + p);
const pin = { "pyric": pyric, "pyric-admin": admin, "create-pyric": create, "@pyric/cli": tools, "@pyric/ui": ui };
const pkg = {
  name: "pyric-install-matrix-consumer", private: true, version: "1.0.0", type: "module",
  dependencies: { ...pin, react: "^19", "react-dom": "^19", firebase: "^12" },
  overrides: pin,            // npm
  resolutions: pin,          // bun / yarn
  pnpm: { overrides: pin },  // pnpm <= 10
};
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
// pnpm >= 11 no longer reads "pnpm.overrides" from package.json — it moved to
// pnpm-workspace.yaml. Quote keys + file: values.
const yaml = "overrides:\n" +
  Object.entries(pin).map(([k, v]) => `  "${k}": "${v}"`).join("\n") + "\n";
fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), yaml);
' "${TARBALLS[@]}"

# 3. Install — file: deps + overrides drive everything to the local tarballs.
echo "▸ $PM install (5 file: tarballs + peers, inter-deps pinned local)…"
cd "$CONSUMER"
case "$PM" in
  npm)  npm install --no-audit --no-fund --loglevel=error ;;
  # pnpm 11 blocks (and exits non-zero on) dependency build scripts by default
  # (esbuild/@firebase/util/protobufjs); the matrix only needs resolution, not
  # those builds, so allow them rather than fail. strict-peer off keeps the
  # apples-to-apples resolution check from tripping on peer mismatches.
  pnpm) pnpm install --config.strict-peer-dependencies=false --config.dangerouslyAllowAllBuilds=true ;;
  bun)  bun install ;;
esac

# 4. Resolve EVERY advertised subpath of all five packages, derived from the INSTALLED
#    manifests (drift-free — no hardcoded list to fall out of sync).
cat > "$CONSUMER/__matrix-resolve.mjs" <<'NODECHECK'
import { readFileSync } from 'node:fs';
const PKGS = ['pyric', 'pyric-admin', 'create-pyric', '@pyric/cli', '@pyric/ui'];
let failed = false, total = 0;
for (const pkg of PKGS) {
  const manifest = JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, 'utf8'));
  const subpaths = Object.keys(manifest.exports ?? {});
  for (const sub of subpaths) {
    const spec = pkg + sub.slice(1); // "." -> "", "./x" -> "/x"
    try {
      const mod = await import(spec);
      if (Object.keys(mod).length === 0) { console.error(`  ✗ ${spec} — 0 exports`); failed = true; }
      else total++;
    } catch (e) {
      console.error(`  ✗ ${spec} — ${e?.code ?? ''} ${e?.message ?? e}`);
      failed = true;
    }
  }
}
if (failed) { console.error('install matrix: subpath resolution FAILED'); process.exit(1); }
console.log(`  ✓ all ${total} advertised subpaths resolve under ${process.env.PM_LABEL ?? 'this manager'}`);
NODECHECK
PM_LABEL="$PM" node __matrix-resolve.mjs

# 5. Execute a small public-command proof through this package manager's bin
# link. The helper owns only command behavior; this script remains the single
# source of truth for packing and installing the consumer.
node "$ROOT/scripts/packed-cli-smoke.mjs" \
  "$CONSUMER/node_modules/.bin/pyric" "$WORK/cli-smoke"

echo "✓ install matrix PASS ($PM) — libraries install, subpaths resolve, CLI executes"
