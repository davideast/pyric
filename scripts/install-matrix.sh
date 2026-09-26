#!/usr/bin/env bash
# Install + subpath-resolution matrix for ONE package manager.
#
# Package managers resolve `exports`, scoped names, and local tarballs with
# meaningfully different algorithms (npm's hoisting vs pnpm's strict symlinked
# store vs bun's layout). A package that resolves cleanly under npm can fail under
# pnpm/bun — so the publishable libs are installed from their REAL tarballs,
# every advertised subpath is imported, the installed CLI is executed, and a Vite
# app using the pyric() plugin is started under each manager in turn.
#
# This is the resolution-portability leg; the full runtime/serve/contract proof
# lives in scripts/packaging-test.sh (npm). Peer deps
# (react/react-dom/firebase/vite) are installed explicitly so we test OUR
# exports resolution apples-to-apples, not each manager's peer-install policy.
#
# Usage: bash scripts/install-matrix.sh <npm|pnpm|bun>
set -euo pipefail

PM="${1:?usage: install-matrix.sh <npm|pnpm|bun>}"
case "$PM" in npm|pnpm|bun) ;; *) echo "unknown package manager: $PM" >&2; exit 2 ;; esac
command -v "$PM" >/dev/null 2>&1 || { echo "✗ $PM is not installed" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "━━━ install matrix: $PM ($("$PM" --version 2>/dev/null | head -1)) ━━━"

# 1. The real publish artifacts (rewritten workspace:* → ^version). CI passes
#    the tarballs already proven by packaging-test.sh; local use falls back to
#    building and packing when dist/packages has not been prepared.
if [ -z "${PYRIC_PACKAGE_ARTIFACT_DIR:-}" ] && [ ! -f dist/packages/manifest.json ]; then
  echo "▸ packing publishable libraries (npm run pack)…"
  bash scripts/pack-packages.sh >/dev/null
fi

TARBALLS=()
if [ -n "${PYRIC_PACKAGE_ARTIFACT_DIR:-}" ]; then
  while IFS= read -r tb; do
    TARBALLS+=("$tb")
  done < <(ARTIFACT_DIR="$PYRIC_PACKAGE_ARTIFACT_DIR" node -e "
const path = require('path');
const fs = require('fs');
const packages = ['packages/pyric', 'packages/pyric-admin', 'packages/create-pyric', 'packages/cli', 'packages/ui'];
for (const dir of packages) {
  const manifest = require(path.join(process.cwd(), dir, 'package.json'));
  const file = manifest.name.replace(/^@/, '').replaceAll('/', '-') + '-' + manifest.version + '.tgz';
  const full = path.resolve(process.env.ARTIFACT_DIR, file);
  if (!fs.existsSync(full)) {
    console.error('missing proven package artifact: ' + full);
    process.exit(1);
  }
  console.log(full);
}
")
else
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
fi
for tb in "${TARBALLS[@]}"; do
  [ -f "$tb" ] || { echo "✗ missing tarball $tb (run: npm run pack)" >&2; exit 1; }
done

# 2. Fresh consumer. The five packages are declared as `file:` tarball deps, and the
#    SAME local tarballs are pinned via every manager's override channel
#    (overrides / resolutions / pnpm.overrides). Without this, the inter-package
#    deps can resolve differently per manager. Pinning makes the matrix test OUR
#    exports resolution apples-to-apples, not registry availability. (peers:
#    react/react-dom for @pyric/ui, firebase for the SDKs, vite for the
#    optional @pyric/cli/vite entry.)
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
  dependencies: {
    ...pin,
    react: "^19",
    "react-dom": "^19",
    firebase: "^12",
    vite: "^5",
  },
  overrides: pin,            // npm
  resolutions: pin,          // bun / yarn
  pnpm: { overrides: pin },  // pnpm <= 10
};
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
// pnpm >= 11 no longer reads "pnpm.overrides" from package.json — it moved to
// pnpm-workspace.yaml. Quote keys + file: values.
// pnpm 11+ refuses to finish an install that ignored a dependency build script.
// strictDepBuilds returns that to a warning, which is what a consumer installing
// these packages sees: the scripts stay unrun. Allowing them instead would
// execute third-party postinstall scripts in CI and test a state no consumer
// gets. The matrix checks resolution, so unrun build scripts do not affect it.
const yaml = "strictDepBuilds: false\noverrides:\n" +
  Object.entries(pin).map(([k, v]) => `  "${k}": "${v}"`).join("\n") + "\n";
fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), yaml);
' "${TARBALLS[@]}"

# 3. Install — file: deps + overrides drive everything to the local tarballs.
echo "▸ $PM install (5 file: tarballs + peers, inter-deps pinned local)…"
cd "$CONSUMER"
case "$PM" in
  npm)  npm install --no-audit --no-fund --loglevel=error ;;
  # pnpm 11+ blocks dependency build scripts (esbuild/@firebase/util/protobufjs)
  # and exits non-zero. strictDepBuilds in the generated pnpm-workspace.yaml
  # returns that to a warning. strict-peer off keeps the apples-to-apples
  # resolution check from tripping on peer mismatches.
  pnpm) pnpm install --config.strict-peer-dependencies=false ;;
  bun)  bun install ;;
esac

# 4. Resolve EVERY advertised subpath of all five packages, derived from the INSTALLED
#    manifests (drift-free — no hardcoded list to fall out of sync).
cat > "$CONSUMER/__matrix-resolve.mjs" <<'NODECHECK'
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const PKGS = ['pyric', 'pyric-admin', 'create-pyric', '@pyric/cli', '@pyric/ui'];
// The browser modules `withPyric` aliases client `firebase/*` imports to. They
// start the browser runtime on import, which keeps a Node process alive, so
// each one is resolved to an installed file without running it.
const BROWSER_ENTRY_PREFIX = '@pyric/cli/next/internal/';
let failed = false, total = 0;
for (const pkg of PKGS) {
  const manifest = JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, 'utf8'));
  const subpaths = Object.keys(manifest.exports ?? {});
  for (const sub of subpaths) {
    const spec = pkg + sub.slice(1); // "." -> "", "./x" -> "/x"
    if (spec.startsWith(BROWSER_ENTRY_PREFIX)) {
      try {
        const file = fileURLToPath(import.meta.resolve(spec));
        if (existsSync(file)) total++;
        else { console.error(`  ✗ ${spec} — resolves to a missing file: ${file}`); failed = true; }
      } catch (e) {
        console.error(`  ✗ ${spec} — ${e?.code ?? ''} ${e?.message ?? e}`);
        failed = true;
      }
      continue;
    }
    try {
      const mod = await import(spec);
      // Flow deliberately exports types only. Compile a consuming module below
      // so each manager must resolve its declarations as well as its JS entry.
      if (Object.keys(mod).length === 0 && spec !== '@pyric/cli/flow') { console.error(`  ✗ ${spec} — 0 exports`); failed = true; }
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
cat > "$CONSUMER/__flow-types.mts" <<'FLOWTYPES'
import type { FlowTreatment } from '@pyric/cli/flow';
export default {
  css: 'html[data-pyric-treatment="team:quiet"] [data-pyric-flow] { outline: 1px solid teal; }',
  mount({ document, container, history }) {
    const summary = document.createElement('span');
    container.append(summary);
    return {
      update() { summary.textContent = String(history().length); },
      dispose() { summary.remove(); },
    };
  },
} satisfies FlowTreatment;
FLOWTYPES
node "$ROOT/node_modules/typescript/bin/tsc" --noEmit --strict --skipLibCheck \
  --module nodenext --target es2022 "$CONSUMER/__flow-types.mts"
echo "  ✓ @pyric/cli/flow declarations resolve and typecheck under $PM"
node "$ROOT/scripts/audit-packed-cli.mjs" \
  "$CONSUMER" \
  "$ROOT/scripts/fixtures/cli-release-contract.json"

# 5. Execute a small public-command proof through this package manager's bin
# link. The helper owns only command behavior; this script remains the single
# source of truth for packing and installing the consumer.
node "$ROOT/scripts/packed-cli-smoke.mjs" \
  "$CONSUMER/node_modules/.bin/pyric" \
  "$WORK/cli-smoke" \
  "$ROOT/scripts/fixtures/cli-release-contract.json"

# 6. Start Vite with the pyric() plugin in a separate consumer app and load its
#    module graph. bun installs with its isolated linker and pnpm with its
#    default symlinked store; in both layouts a package's own dependencies are
#    not resolvable from the app root. Vite resolves `optimizeDeps.include`
#    from the app root and skips dependency discovery for importers under
#    node_modules, so a dependency the page runtime needs from its own package
#    fails to pre-bundle here even though it works in a hoisted install.
VITE_APP="$WORK/vite-app"
mkdir -p "$VITE_APP/src"
VITE_APP_DIR="$VITE_APP" node -e '
const fs = require("fs");
const path = require("path");
const dir = process.env.VITE_APP_DIR;
const [pyric, admin, create, tools, ui] = process.argv.slice(1).map((p) => "file:" + p);
const pin = { "pyric": pyric, "pyric-admin": admin, "create-pyric": create, "@pyric/cli": tools, "@pyric/ui": ui };
const pkg = {
  name: "pyric-install-matrix-vite-app", private: true, version: "1.0.0", type: "module",
  dependencies: { pyric: pyric, "@pyric/cli": tools, firebase: "^12", vite: "^6" },
  overrides: pin,
  resolutions: pin,
  pnpm: { overrides: pin },
};
fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
const yaml = "strictDepBuilds: false\noverrides:\n" +
  Object.entries(pin).map(([k, v]) => `  "${k}": "${v}"`).join("\n") + "\n";
fs.writeFileSync(path.join(dir, "pnpm-workspace.yaml"), yaml);
' "${TARBALLS[@]}"
cat > "$VITE_APP/vite.config.ts" <<'VITECONFIG'
import { defineConfig } from 'vite';
import { pyric } from '@pyric/cli/vite';
export default defineConfig({ plugins: [pyric()] });
VITECONFIG
echo '<script type="module" src="/src/main.ts"></script>' > "$VITE_APP/index.html"
cat > "$VITE_APP/src/main.ts" <<'MAIN'
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
const app = initializeApp({ projectId: 'demo-install-matrix', storageBucket: 'demo-install-matrix.appspot.com' });
getFirestore(app);
getStorage(app);
MAIN
echo "▸ $PM install (Vite app, $PM's isolated layout)…"
cd "$VITE_APP"
case "$PM" in
  npm)  npm install --no-audit --no-fund --loglevel=error ;;
  pnpm) pnpm install --config.strict-peer-dependencies=false ;;
  bun)  bun install --linker isolated ;;
esac
cat > "$VITE_APP/__vite-graph.mjs" <<'VITEGRAPH'
// Fetch the page, then every same-origin module it imports, transitively. A
// module Vite cannot transform or pre-bundle answers with a non-2xx status.
const origin = process.argv[2];
const deadline = Date.now() + 60_000;
while (true) {
  try { if ((await fetch(origin + '/')).ok) break; } catch {}
  if (Date.now() > deadline) { console.error('  ✗ Vite did not answer within 60s'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 500));
}
const IMPORT_RE = /(?:\bimport|\bexport)\s*(?:[\w*{}\s,$]*?\bfrom\s*)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
const seen = new Set();
const queue = ['/src/main.ts'];
let failed = false;
while (queue.length > 0 && seen.size < 2000) {
  const url = queue.shift();
  if (seen.has(url)) continue;
  seen.add(url);
  const response = await fetch(origin + url);
  const body = await response.text();
  if (!response.ok) {
    console.error(`  ✗ ${url}: HTTP ${response.status}\n${body.slice(0, 400)}`);
    failed = true;
    continue;
  }
  for (const m of body.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (spec.startsWith('/')) queue.push(spec);
  }
}
if (failed) process.exit(1);
console.log(`  ✓ Vite served ${seen.size} modules of the page's graph`);
VITEGRAPH
VITE_PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
node node_modules/vite/bin/vite.js --port "$VITE_PORT" --strictPort > vite.log 2>&1 &
VITE_PID=$!
VITE_STATUS=0
node __vite-graph.mjs "http://localhost:$VITE_PORT" || VITE_STATUS=$?
sleep 2
kill "$VITE_PID" 2>/dev/null || true
wait "$VITE_PID" 2>/dev/null || true
VITE_ERRORS='Failed to resolve dependency|Error during dependency optimization|error while updating dependencies|Failed to scan for dependencies|Pre-transform error'
if grep -Eq "$VITE_ERRORS" vite.log; then
  echo "  ✗ Vite reported a dependency or pre-bundle error under $PM:" >&2
  cat vite.log >&2
  exit 1
fi
if [ "$VITE_STATUS" -ne 0 ]; then
  echo "  ✗ Vite could not serve the page's module graph under $PM:" >&2
  cat vite.log >&2
  exit 1
fi
echo "  ✓ Vite starts with pyric() and pre-bundles cleanly under $PM"

echo "✓ install matrix PASS ($PM): libraries install, subpaths resolve, CLI executes, Vite loads"
