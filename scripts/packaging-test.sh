#!/usr/bin/env bash
# Packaging gate: prove every publishable workspace package can be
# packed, installed into a fresh consumer project, and that its
# declared subpath exports actually resolve at runtime.
#
# Why this exists:
#  - `npm pack` rewrites `workspace:*` deps to concrete version ranges
#    using the workspace's own version. A bad ./exports field or a dist
#    file that doesn't ship in `files` shows up here and nowhere else.
#  - Bins need an executable bit + a real shebang to be `npx`-runnable.
#  - Subpath import failures are silent until a consumer hits them; this
#    script hits every advertised subpath once.
#
# Run as: bash scripts/packaging-test.sh    (or `bun run test:packaging`)
#
# Exits 0 on success, non-zero on first failure. Cleans up its work dir
# on success; leaves it intact on failure for debugging.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${TMPDIR:-/tmp}/pyric-packaging-test"
NPM_CACHE="${TMPDIR:-/tmp}/npm-cache-pyric-packaging-test"

# Publishable packages, in dependency order (dependencies first).
# - pyric is foundational (everyone else workspace:* it)
# - pyric-admin depends on pyric
# - create-pyric is standalone (scaffolder; no Firebase SDK deps)
# - @pyric/cli depends on pyric + pyric-admin + create-pyric
# - @pyric/ui peer-depends on pyric
PACKAGES=(
  "packages/pyric"         # pyric
  "packages/pyric-admin"   # pyric-admin
  "packages/create-pyric"  # create-pyric (bin: create-pyric)
  "packages/cli"           # @pyric/cli (bin: pyric)
  "packages/ui"            # @pyric/ui
)

# Subpath exports per package — used to assert every advertised entry resolves.
# Derived from package.json so the smoke test cannot drift behind newly-added
# public exports.
exported_subpaths() {
  local pkg_dir="$1"
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    // Subpaths flagged pyricUnreleasedExports are stripped from the manifest
    // at pack time (CDD climbing surfaces): they must NOT be smoked as
    // shipped surface, because the published tarball deliberately omits them.
    const unreleased = new Set(manifest.pyricUnreleasedExports ?? []);
    for (const key of Object.keys(manifest.exports ?? {})) {
      if (key === ".") continue;
      if (unreleased.has(key)) continue;
      process.stdout.write(`${manifest.name}${key.slice(1)}\n`);
    }
  ' "$ROOT/$pkg_dir/package.json"
}

PYRIC_SUBPATHS=( $(exported_subpaths packages/pyric) )
PYRIC_ADMIN_SUBPATHS=( $(exported_subpaths packages/pyric-admin) )
PYRIC_CLI_SUBPATHS=( $(exported_subpaths packages/cli) )
PYRIC_UI_SUBPATHS=( $(exported_subpaths packages/ui) )

# Tracks the backgrounded `pyric dev` (Phase 5.5) so a failure mid-smoke
# doesn't leave it listening; killed in the error trap and after the probe.
SERVE_PID=""
cleanup_on_error() {
  [ -n "$SERVE_PID" ] && kill "$SERVE_PID" 2>/dev/null
  echo ""
  echo "✗ packaging gate FAILED — work dir preserved for debugging:"
  echo "  $WORK"
}
trap cleanup_on_error ERR

# ─── Phase 0: clean ────────────────────────────────────────────────────
echo "━━━ Phase 0: clean ━━━"
rm -rf "$WORK"
mkdir -p "$WORK"

# ─── Phase 1: build all packages (needed for tarball contents) ─────────
echo ""
echo "━━━ Phase 1: build ━━━"
cd "$ROOT"
bash scripts/build.sh

# ─── Phase 1.5: static manifest gate (fail fast before the slow pack+install) ──
# publint + attw (types resolution) + exports↔dist drift. These catch what the
# runtime-import phases below structurally cannot (the `types` condition, a missing
# export). Cheap + flake-free, so run them first.
echo ""
echo "━━━ Phase 1.5: manifest lint (publint + attw + exports drift) ━━━"
bash "$ROOT/scripts/manifest-lint.sh"

# ─── Phase 2: pack each publishable package ────────────────────────────
# (Plain variables instead of associative arrays — macOS ships bash 3.2.)
echo ""
echo "━━━ Phase 2: pack ━━━"
# Pack a workspace package AND rewrite any leftover `workspace:*` deps
# to `^<version-of-target-workspace>`. npm pack does not rewrite
# workspace: deps (pnpm does), so the produced tarball would ship with
# literal `workspace:*` to consumers — they hit EUNSUPPORTEDPROTOCOL on
# install. We hit this externally with @inbrowser/relay@0.2.0; this
# rewrite ensures we never ship the same bug.
#
# After rewrite we VERIFY no `workspace:` strings remain in the manifest
# — this is the load-bearing check that prevents a future regression
# (e.g. someone adds a fourth dep field name we forgot to handle).
pack_one() {
  local pkg_dir="$1"
  local name
  name=$(jq -r '.name' "$ROOT/$pkg_dir/package.json")
  echo "▸ packing $name" >&2
  local tarball
  tarball=$(cd "$ROOT/$pkg_dir" && npm pack --silent --pack-destination "$WORK" --cache "$NPM_CACHE")
  local full="$WORK/$tarball"

  # Extract, rewrite workspace:* → ^<version>, repack, then verify.
  local tmp
  tmp=$(mktemp -d)
  tar -xzf "$full" -C "$tmp"
  if grep -q 'workspace:' "$tmp/package/package.json"; then
    node "$ROOT/scripts/lib/rewrite-workspace-deps.mjs" \
      "$tmp/package/package.json" "$ROOT"
    (cd "$tmp" && tar -czf "$full" package)
  fi
  rm -rf "$tmp"

  # Verification: the published tarball MUST NOT contain workspace: deps.
  # If this fires, the rewrite helper has a bug or a new dep-field name
  # appeared. Fail loudly with the offending lines.
  if tar -xzOf "$full" package/package.json | grep -nE '"workspace:'; then
    echo "  ✗ $name tarball still contains workspace: deps after rewrite" >&2
    echo "    (see lines above; fix scripts/lib/rewrite-workspace-deps.mjs)" >&2
    exit 1
  fi

  echo "    → $full" >&2
  printf '%s' "$full"
}
TARBALL_PYRIC=$(pack_one packages/pyric)
TARBALL_PYRIC_ADMIN=$(pack_one packages/pyric-admin)
TARBALL_CREATE_PYRIC=$(pack_one packages/create-pyric)
TARBALL_PYRIC_CLI=$(pack_one packages/cli)
TARBALL_UI=$(pack_one packages/ui)

assert_no_sdk_runtime_deps() {
  local tarball="$1" name="$2"
  if ! tar -xzOf "$tarball" package/package.json | jq -e '
    ((.dependencies // {}) | has("firebase") or has("firebase-admin")) | not
  ' >/dev/null; then
    echo "  ✗ $name packed manifest contains a Firebase SDK runtime dependency" >&2
    exit 1
  fi
  echo "  ✓ $name packed manifest has no Firebase SDK runtime dependency"
}
assert_no_sdk_runtime_deps "$TARBALL_PYRIC" "pyric"
assert_no_sdk_runtime_deps "$TARBALL_PYRIC_ADMIN" "pyric-admin"
assert_no_sdk_runtime_deps "$TARBALL_PYRIC_CLI" "@pyric/cli"

# ─── Phase 2.5: publish file-set + runtime-asset presence ──────────────
# Hermetic (NO registry): `npm pack --dry-run --json` computes the exact file set
# npm would publish and validates the manifest — assert it's non-trivial and ships
# dist/. (A full `npm publish --dry-run` additionally checks version/tag legality
# against the registry; that's non-hermetic + depends on what's already published,
# so it's a release-prep step, not a CI gate — see plans/packaging-hardening.md.)
# Then assert the load-bearing RUNTIME ASSETS are actually inside the published
# tarball: `files: ["dist","README.md"]` is a whitelist, so a build that forgets to
# copy an asset (the .ohm grammars / stdlib .rules) ships a tarball that imports
# fine but throws the instant the rules engine loads its grammar. (mcp is
# sunsetting → out of scope.)
echo ""
echo "━━━ Phase 2.5: publish file-set + asset presence ━━━"
packset_check() {
  local pkg_dir="$1" name="$2" n
  n=$( (cd "$ROOT/$pkg_dir" && npm pack --dry-run --json 2>/dev/null) | node -e '
    const d = JSON.parse(require("fs").readFileSync(0));
    const f = d[0];
    if (!f || !f.entryCount || !f.files.some((x) => x.path.startsWith("dist/"))) process.exit(1);
    process.stdout.write(String(f.entryCount));
  ' ) || { echo "  ✗ $name — npm pack --dry-run produced no valid file set (dist/ missing?)" >&2; exit 1; }
  echo "  ✓ $name — publish file set computes ($n files, dist/ present)"
}
assert_tar_has() {
  local tb="$1" pattern="$2" desc="$3" listing
  # List the archive fully into a var BEFORE matching. `tar -tzf "$tb" | grep -qE`
  # trips `set -o pipefail`: grep -q exits on the first match and closes the pipe,
  # tar then dies on SIGPIPE (exit 141), and pipefail fails the whole pipeline even
  # though the pattern matched. GNU tar (Linux/CI) hits this; bsdtar (macOS) does
  # not — which is exactly why this passed locally but failed in CI. The here-string
  # has no upstream process to SIGPIPE.
  listing=$(tar -tzf "$tb")
  if grep -qE "$pattern" <<<"$listing"; then
    echo "  ✓ $desc"
  else
    echo "  ✗ MISSING from tarball: $desc (expected pattern: $pattern)" >&2
    exit 1
  fi
}
packset_check packages/pyric pyric
packset_check packages/pyric-admin pyric-admin
packset_check packages/create-pyric create-pyric
packset_check packages/cli @pyric/cli
packset_check packages/ui @pyric/ui
# Load-bearing runtime assets — pass import() but break at first use if dropped.
assert_tar_has "$TARBALL_PYRIC" 'package/dist/rules/grammar/FirestoreRules\.ohm$' "pyric ships the Firestore rules grammar (.ohm)"
assert_tar_has "$TARBALL_PYRIC" 'package/dist/rules/rtdb/grammar/RtdbExpr\.ohm$' "pyric ships the RTDB rules grammar (.ohm)"
assert_tar_has "$TARBALL_PYRIC" 'package/dist/rules/modules/stdlib/.*\.rules$' "pyric ships the rules stdlib modules (.rules)"
assert_tar_has "$TARBALL_CREATE_PYRIC" 'package/dist/bin\.js$' "create-pyric ships the create-pyric bin"
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/cli/index\.js$' "@pyric/cli ships the pyric CLI bin"
# The Vite plugin's `ui` option + `pyric dev --ui` resolve the Studio app from
# dist/serve/studio-ui (build-embedded). The plugin's firebase swap resolves the
# entries from dist/serve/entries. Both are `files:["dist"]`-whitelisted assets that
# import fine but 404 / break the swap for installed users if the build drops them.
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/studio-ui/index\.html$' "@pyric/cli ships the Studio app shell (vite plugin ui + dev --ui)"
# index.html hard-references hashed assets/*.{js,css}; without them the served app
# renders a blank root that 404s its own bundle. The index.html fallback only fires
# for extension-less paths, so a dropped assets/ dir would pass an index-only check.
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/studio-ui/assets/.*\.js$' "@pyric/cli ships the Studio app JS bundle"
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/studio-ui/assets/.*\.css$' "@pyric/cli ships the Studio app CSS bundle"
# All swap/boot entries are load-bearing: defaultSdkEntries() throws at plugin
# construction if any is missing. Guard each, not just firestore.
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/entries/app\.js$' "@pyric/cli ships the firebase/app swap entry"
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/entries/auth\.js$' "@pyric/cli ships the firebase/auth swap entry"
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/entries/firestore\.js$' "@pyric/cli ships the firebase/firestore swap entry"
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/entries/database\.js$' "@pyric/cli ships the firebase/database swap entry"
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/entries/storage\.js$' "@pyric/cli ships the firebase/storage swap entry"
assert_tar_has "$TARBALL_PYRIC_CLI" 'package/dist/serve/entries/init\.js$' "@pyric/cli ships the sandbox boot entry"

# ─── Phase 3: install all tarballs into a fresh consumer project ──────
echo ""
echo "━━━ Phase 3: install in consumer ━━━"
mkdir -p "$WORK/consumer"
cd "$WORK/consumer"

cat > package.json <<JSON
{
  "name": "pyric-packaging-test-consumer",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "pyric": "file:${TARBALL_PYRIC}",
    "pyric-admin": "file:${TARBALL_PYRIC_ADMIN}",
    "create-pyric": "file:${TARBALL_CREATE_PYRIC}",
    "@pyric/cli": "file:${TARBALL_PYRIC_CLI}",
    "@pyric/ui": "file:${TARBALL_UI}",
    "firebase": "^12.12.0",
    "firebase-admin": "^13.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  }
}
JSON

echo "▸ npm install (resolving from local tarballs)"
npm install --cache "$NPM_CACHE" --prefer-offline --no-audit --no-fund --loglevel=error

# A second consumer owns the SDK-absence proof. The broad consumer above
# deliberately installs Firebase for inactive-production and UI peer coverage;
# using it for CLI smoke tests would mask a transitive dependency regression.
SDK_FREE_CONSUMER="$WORK/sdk-free-consumer"
mkdir -p "$SDK_FREE_CONSUMER"
cat > "$SDK_FREE_CONSUMER/package.json" <<JSON
{
  "name": "pyric-sdk-free-cli-consumer",
  "version": "0.0.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "pyric": "file:${TARBALL_PYRIC}",
    "pyric-admin": "file:${TARBALL_PYRIC_ADMIN}",
    "create-pyric": "file:${TARBALL_CREATE_PYRIC}",
    "@pyric/cli": "file:${TARBALL_PYRIC_CLI}"
  }
}
JSON
(cd "$SDK_FREE_CONSUMER" && npm install --cache "$NPM_CACHE" --prefer-offline --no-audit --no-fund --loglevel=error)
test ! -e "$SDK_FREE_CONSUMER/node_modules/firebase"
test ! -e "$SDK_FREE_CONSUMER/node_modules/firebase-admin"
echo "  ✓ packed CLI dependency closure installs without firebase or firebase-admin"

# ─── Phase 4: subpath resolution test ──────────────────────────────────
# For each advertised subpath, write a tiny file that imports it and
# logs the keys. Failing import = subpath broken.
echo ""
echo "━━━ Phase 4: subpath resolution ━━━"

run_subpath_check() {
  # Batched: ONE node process imports every subpath argument in order —
  # identical per-subpath checks and output, minus ~1s of process startup
  # per subpath (measured: Phase 4 was ~20 single-process spawns × ~1s).
  # The check file lives INSIDE the consumer so node's module resolver
  # walks up into consumer/node_modules to find the packages.
  printf '%s\n' "$@" > "$WORK/consumer/__subpaths.txt"
  cat > "$WORK/consumer/__subpath-check.mjs" <<'CHECKJS'
import { readFileSync } from 'node:fs';
const subpaths = readFileSync('__subpaths.txt', 'utf8').split('\n').filter(Boolean);
// Side-effect-only subpaths (register loaders for `node --import`): importing
// them IS the contract; they intentionally export zero symbols. Import failure
// still fails the gate.
const SIDE_EFFECT_ONLY = new Set(['@pyric/cli/register']);
let failed = false;
for (const subpath of subpaths) {
  try {
    const mod = await import(subpath);
    const keys = Object.keys(mod).sort();
    if (keys.length === 0) {
      if (SIDE_EFFECT_ONLY.has(subpath)) {
        console.log('  ✓ ' + subpath + ' (side-effect-only register loader; zero exports by design)');
        continue;
      }
      console.error('  ✗ ' + subpath + ' — imported but exported zero symbols');
      failed = true;
      continue;
    }
    console.log('  ✓ ' + subpath + ' (' + keys.length + ' exports)');
  } catch (err) {
    console.error('  ✗ ' + subpath + ' — ' + (err && err.message ? err.message : String(err)));
    failed = true;
  }
}
if (failed) process.exit(1);
CHECKJS
  (cd "$WORK/consumer" && node __subpath-check.mjs)
}

echo "▸ pyric subpaths"
run_subpath_check "${PYRIC_SUBPATHS[@]}"

echo "▸ pyric-admin subpaths"
run_subpath_check "${PYRIC_ADMIN_SUBPATHS[@]}"

echo "▸ @pyric/cli subpaths"
run_subpath_check "${PYRIC_CLI_SUBPATHS[@]}"

echo "▸ @pyric/ui subpaths"
run_subpath_check "${PYRIC_UI_SUBPATHS[@]}"

# ─── Phase 4b: export-shape assertions ─────────────────────────────────
# Phase 4 proves each subpath RESOLVES; this proves the load-bearing NAMED
# exports are where consumers expect them — and, for the M3 bridge fold, that
# the retired standalone `vitePlugin` did NOT come back. Phase 4's "≥1 export"
# bar would pass even if `pyricSandbox` were renamed or `vitePlugin` re-added.
echo ""
echo "━━━ Phase 4b: export-shape assertions ━━━"
cat > "$WORK/consumer/__export-shape.mjs" <<'SHAPEJS'
let failed = false;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed = true; };

async function assertNotExported(subpath) {
  try {
    await import(subpath);
    bad(subpath + ' still resolves');
  } catch (error) {
    if (error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      ok(subpath + ' is not exported');
    } else {
      bad(subpath + ' failed for an unexpected reason: ' + String(error));
    }
  }
}

// The Vite plugin entry exposes the swap+bridge plugin factory.
const vite = await import('@pyric/cli/vite');
if (typeof vite.pyricSandbox === 'function') ok('@pyric/cli/vite exports pyricSandbox()');
else bad('@pyric/cli/vite is MISSING pyricSandbox (named export gone/renamed)');

// The bridge Node entry must NOT re-expose the retired standalone Vite plugin —
// the Vite integration is `pyricSandbox({ bridge })`, not a bridge-only plugin.
const bridge = await import('@pyric/cli/bridge');
if (!('vitePlugin' in bridge)) ok('@pyric/cli/bridge does NOT export vitePlugin (retired in M3)');
else bad('@pyric/cli/bridge STILL exports vitePlugin (the M3 retire regressed)');
// The bridge server surface consumers do rely on stays put.
for (const sym of ['createBridge', 'startServer']) {
  if (typeof bridge[sym] === 'function') ok('@pyric/cli/bridge exports ' + sym + '()');
  else bad('@pyric/cli/bridge is MISSING ' + sym);
}
for (const sym of [
  'createInteractiveConfirmHandler',
  'createAutoApproveHandler',
  'createDenyAllHandler',
  'createPolicyHandler',
  'hasInteractiveTTY',
  'DEFAULT_PROD_POLICIES',
  'DEFAULT_SANDBOX_POLICY',
  'FALLBACK_PROD_POLICY',
  'buildPolicyMap',
  'policyFor',
]) {
  if (!(sym in bridge)) ok('@pyric/cli/bridge does NOT export retired ' + sym);
  else bad('@pyric/cli/bridge STILL exports retired ' + sym);
}

// Credential-free discovery is the retained contract. Production discovery
// has no package entry or adapter export.
const discover = await import('@pyric/cli/discover');
if (!('createRestCrawlerFirestore' in discover)) {
  ok('@pyric/cli/discover does NOT export production REST discovery');
} else {
  bad('@pyric/cli/discover STILL exports production REST discovery');
}
await assertNotExported('@pyric/cli/discover/production');

// Production deployment is owned by firebase-tools. The old programmatic
// subpath must fail resolution instead of lingering as a compatibility shim.
await assertNotExported('@pyric/cli/deploy');

// Pyric does not own a browser OAuth flow or persisted Google login. Hosted
// Rules Test API verification resolves its non-interactive credentials inside
// the CLI instead of publishing the former credential toolkit.
await assertNotExported('@pyric/cli/credentials');

// Auth administration is a production control-plane concern. The CLI does
// not publish a programmatic adapter for Identity Toolkit operations.
await assertNotExported('@pyric/cli/auth');

// Production/admin tool composition is not part of the public CLI contract.
await assertNotExported('@pyric/cli/registry');

if (failed) process.exit(1);
SHAPEJS
(cd "$WORK/consumer" && node __export-shape.mjs)

# Start and exercise the installed bridge through its public package entry.
# The fake WebSocket peer is the browser half of the sandbox relay; the MCP
# client proves tools/list and a forwarded call work from the packed artifact.
cat > "$SDK_FREE_CONSUMER/__bridge-smoke.mjs" <<'BRIDGEJS'
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '@pyric/cli/bridge';

const server = await startServer({
  port: 0,
  project: 'packed-smoke',
  disableAuditLog: true,
  silent: true,
});
let socket;
let client;
try {
  const healthBefore = await (await fetch(`${server.url}/health`)).json();
  if (healthBefore.mode !== 'sandbox' || healthBefore.sandboxConnected !== false) {
    throw new Error(`unexpected initial health: ${JSON.stringify(healthBefore)}`);
  }

  socket = new WebSocket(server.url.replace(/^http/, 'ws') + '/sandbox');
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'hello',
      protocol: 1,
      tools: ['sandbox_inspect'],
      sandboxId: 'packed-smoke-peer',
    })));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'hello-ack') resolve();
      if (message.type === 'tool-call') {
        socket.send(JSON.stringify({
          type: 'tool-result',
          id: message.id,
          ok: true,
          result: { ok: true, summary: 'packed sandbox peer responded' },
        }));
      }
    });
  });

  const healthConnected = await (await fetch(`${server.url}/health`)).json();
  if (healthConnected.mode !== 'sandbox' || healthConnected.sandboxConnected !== true) {
    throw new Error(`unexpected connected health: ${JSON.stringify(healthConnected)}`);
  }

  client = new Client({ name: 'packed-bridge-smoke', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
  const listed = await client.listTools();
  if (listed.tools.length !== 35) {
    throw new Error(`packed bridge exposed ${listed.tools.length} tools, expected 35`);
  }
  const called = await client.callTool({ name: 'sandbox_inspect', arguments: {} });
  const payload = JSON.parse(called.content[0].text);
  if (!payload.ok || payload.summary !== 'packed sandbox peer responded') {
    throw new Error(`unexpected forwarded result: ${JSON.stringify(payload)}`);
  }
  if (payload._pyric?.mode !== 'sandbox' || payload._pyric?.project !== 'packed-smoke') {
    throw new Error(`unexpected bridge provenance: ${JSON.stringify(payload._pyric)}`);
  }
  console.log('  ✓ packed @pyric/cli bridge starts, lists 35 tools, and relays a sandbox call');
} finally {
  await client?.close().catch(() => {});
  socket?.close();
  await server.stop();
}
BRIDGEJS
(cd "$SDK_FREE_CONSUMER" && node __bridge-smoke.mjs)

# ─── Phase 5: bin checks ───────────────────────────────────────────────
echo ""
echo "━━━ Phase 5: packed CLI smoke ━━━"

check_bin_executable() {
  local bin="$1"
  local consumer="${2:-$SDK_FREE_CONSUMER}"
  local path="$consumer/node_modules/.bin/$bin"
  if [ ! -x "$path" ]; then
    echo "  ✗ $bin — missing or not executable"
    exit 1
  fi
  echo "  ✓ $bin executable"
}

check_bin_executable "pyric"
check_bin_executable "create-pyric" "$WORK/consumer"
PYRIC_BIN="$SDK_FREE_CONSUMER/node_modules/.bin/pyric"
CREATE_PYRIC_BIN="$WORK/consumer/node_modules/.bin/create-pyric"
node "$ROOT/scripts/packed-cli-smoke.mjs" "$PYRIC_BIN" "$WORK/cli-smoke"
node "$ROOT/scripts/packed-mcp-smoke.mjs" \
  "$PYRIC_BIN" \
  "$WORK/mcp-smoke" \
  "$ROOT/packages/cli/dist/bridge/server/mcp-contract.js"

# The packed Node register hook must intercept canonical imports before Node
# searches for the absent production SDK packages.
cat > "$SDK_FREE_CONSUMER/__register-smoke.mjs" <<'REGISTERSMOKE'
import assert from 'node:assert/strict';
const admin = await import('firebase-admin/database');
const appModule = await import('firebase/app');
const firestore = await import('firebase/firestore');
assert.equal(typeof admin.getDatabase, 'function');
const app = appModule.initializeApp({ projectId: 'packed-register-smoke' });
assert.equal(app[Symbol.for('pyric.app.target')], 'sandbox');
assert.equal(typeof firestore.getFirestore(app), 'object');
console.log('  ✓ packed Node register redirects canonical imports without Firebase SDKs');
REGISTERSMOKE
(cd "$SDK_FREE_CONSUMER" && PYRIC_SANDBOX=local node --import @pyric/cli/register __register-smoke.mjs)

# create-pyric smoke: scaffold a Vite web app into a fresh directory and
# assert the load-bearing files exist (vite.config imports @pyric/cli/vite).
echo "▸ create-pyric smoke"
CREATE_OUT="$WORK/create-smoke-app"
rm -rf "$CREATE_OUT"
"$CREATE_PYRIC_BIN" "$CREATE_OUT"
test -f "$CREATE_OUT/vite.config.ts"
grep -q "@pyric/cli/vite" "$CREATE_OUT/vite.config.ts"
grep -q "pyricSandbox" "$CREATE_OUT/vite.config.ts"
test -f "$CREATE_OUT/package.json"
grep -q '"dev": "vite"' "$CREATE_OUT/package.json"
echo "  ✓ create-pyric scaffolds Vite + @pyric/cli/vite"

# ─── Phase 5.5: serve smoke (init + serve from the packed bin) ─────────
# The subpath + bin checks above prove imports resolve, but they never boot
# the in-page sandbox runtime. A post-install `pyric dev`/bundler break
# (e.g. a dist path the tarball doesn't ship, or an esbuild plugin that can't
# resolve pyric's SDK from node_modules) would pass everything above yet fail
# the moment a user runs serve. This phase scaffolds a fresh app with the
# packed `pyric init`, starts `pyric dev` headless on an ephemeral port, and
# probes the readiness endpoint — the one thing that exercises the real serve
# path from the published tarball.
#
# Uses `--template static`: the default `web` template scaffolds a Vite app
# (served by `vite dev`, `hosting.public` → `dist` which doesn't exist until a
# build), so it isn't what `pyric dev` consumes. The `static` template is the
# serve-era no-bundler scaffold (a ready `public/` dir) — exactly the path this
# smoke exercises. (The Vite-plugin path is covered by @pyric/cli' own tests.)
echo ""
echo "━━━ Phase 5.5: serve smoke ━━━"
SMOKE="$WORK/serve-smoke"
mkdir -p "$SMOKE"
( cd "$SMOKE" && "$PYRIC_BIN" init --template static --json >/dev/null )
echo "  ✓ pyric init scaffolded a static app from the tarball"

# Start serve in the background. `--json` puts the machine-readable line on
# stdout AND suppresses the browser auto-open (no TTY/CI also suppress it);
# `--port 0` binds an ephemeral port so the gate never collides with a real one.
( cd "$SMOKE" && "$PYRIC_BIN" dev --port 0 --json ) > "$SMOKE/serve.out" 2> "$SMOKE/serve.err" &
SERVE_PID=$!

# Poll for the JSON contract line (printed once the server is listening).
SERVE_URL=""
for _ in $(seq 1 80); do
  if [ -s "$SMOKE/serve.out" ]; then
    SERVE_URL=$(head -1 "$SMOKE/serve.out" | jq -r '.url // empty' 2>/dev/null)
    [ -n "$SERVE_URL" ] && break
  fi
  # Bail early if serve died before printing a URL.
  kill -0 "$SERVE_PID" 2>/dev/null || break
  sleep 0.5
done
if [ -z "$SERVE_URL" ]; then
  echo "  ✗ pyric dev never reported a ready URL"
  echo "    stderr:"; sed 's/^/      /' "$SMOKE/serve.err"
  exit 1
fi

# Readiness probe: GET /__pyric/init.json must be 200 carrying the live rules
# hash (the documented serve readiness contract).
if ! curl -fsS "$SERVE_URL/__pyric/init.json" 2>/dev/null | jq -e 'has("rulesHash")' >/dev/null; then
  echo "  ✗ GET $SERVE_URL/__pyric/init.json did not return a valid init payload"
  exit 1
fi
echo "  ✓ pyric dev booted ($SERVE_URL) and /__pyric/init.json resolved"

kill "$SERVE_PID" 2>/dev/null
wait "$SERVE_PID" 2>/dev/null || true
SERVE_PID=""

# ─── Phase 5.6: runtime smoke (RUN the installed packages, don't just import) ──
# Phases 4/5 prove imports + the bin resolve; this RUNS the asset-dependent code
# paths a bare import() never reaches — the rules grammar (.ohm) and stdlib, the
# sandbox core, the admin SDK ↔ pyric interop, and @pyric/ui's React graph under
# node. A missing copied asset or a broken transitive/peer resolution passes every
# phase above yet fails here, the moment a consumer actually uses the library.
echo ""
echo "━━━ Phase 5.6: runtime smoke ━━━"
cat > "$WORK/consumer/__runtime-smoke.mjs" <<'NODESMOKE'
let failed = false;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed = true; };
const GOOD_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /users/{uid} { allow read, write: if request.auth != null && request.auth.uid == uid; }
  }
}`;

// pyric — rules grammar (FirestoreRules.ohm asset) + sandbox core, no indexedDB.
try {
  const { initializeSandbox } = await import('pyric/sandbox');
  const firestore = await import('pyric/firestore');
  const { getFirestore } = firestore;
  const { inspect, seedDocuments, setRules, snapshotDocuments } = await import('pyric/sandbox/firestore');
  const { firestoreRules, lint } = await import('pyric/rules');
  // firestoreRules() compiles the source — throws if the grammar asset is
  // missing, so a successful construct proves the .ohm asset shipped.
  const ruleset = firestoreRules(GOOD_RULES);
  const issues = lint(GOOD_RULES);
  if (!Array.isArray(issues)) throw new Error('tolerant lint did not return an issues array');
  const sim = ruleset.simulate([
    { description: 'owner reads own doc', expectation: 'ALLOW', method: 'get', path: 'users/alice', auth: { uid: 'alice' } },
  ]);
  if (sim.passed !== 1) throw new Error('simulate did not pass the owner case (grammar/simulator asset missing?)');
  const sandbox = initializeSandbox();
  getFirestore(sandbox);
  setRules(sandbox, GOOD_RULES);
  seedDocuments(sandbox, { 'users/alice': { role: 'owner' } });
  const inspected = inspect(sandbox);
  if (snapshotDocuments(sandbox)['users/alice']?.role !== 'owner') {
    throw new Error('packed sandbox/firestore seed did not reach snapshotDocuments()');
  }
  if (inspected.documents.totalCount !== 1) {
    throw new Error('packed sandbox/firestore inspect did not observe the seeded document');
  }
  if ('sandbox' in firestore) {
    throw new Error('pyric/firestore still exposes the removed sandbox controls');
  }
  ok(`pyric: rules simulation + sandbox/firestore controls + inspect ran (issues=${issues.length})`);
} catch (e) { bad('pyric runtime: ' + (e?.message ?? e)); }

// pyric-admin — admin SDK ↔ pyric interop (resolves firebase-admin transitively).
try {
  const { initializeSandbox } = await import('pyric/sandbox');
  const { getFirestore } = await import('pyric-admin/firestore');
  const db = getFirestore(initializeSandbox());
  if (!db || typeof db !== 'object') throw new Error('getFirestore did not construct a handle');
  ok('pyric-admin: getFirestore(sandbox) handle constructed (admin SDK + pyric interop)');
} catch (e) { bad('pyric-admin runtime: ' + (e?.message ?? e)); }

// @pyric/ui — the React component graph loads under node (peer deps resolved).
try {
  const ui = await import('@pyric/ui/primitives');
  const fns = Object.keys(ui).filter((k) => typeof ui[k] === 'function');
  if (fns.length === 0) throw new Error('no component functions exported');
  ok(`@pyric/ui/primitives loaded under node (${fns.length} component exports; React peer resolved)`);
} catch (e) { bad('@pyric/ui runtime: ' + (e?.message ?? e)); }

if (failed) { console.error('runtime smoke: FAIL'); process.exit(1); }
console.log('  ✓ runtime smoke OK — all packages run from the installed tarballs');
NODESMOKE
( cd "$WORK/consumer" && node __runtime-smoke.mjs )

# ─── Phase 5.7: module-system contract (pins the ESM-only + subpath-only API) ──
# The library is ESM-only and subpath-only BY DESIGN (plans/packaging-hardening.md
# section 4). Pin both so a future exports-map edit can't silently add a CJS/`require`
# entry or a root export without this failing. Asserted from the INSTALLED package:
#   - ESM import of a subpath RESOLVES (the supported path works);
#   - require() of that subpath FAILS — the exports map offers no `require`/`default`
#     condition, so CJS resolution is refused (the ESM-only contract);
#   - a BARE `pyric` specifier FAILS both ways — there is no `.` root export.
echo ""
echo "━━━ Phase 5.7: module-system contract (ESM-only, subpath-only) ━━━"
cat > "$WORK/consumer/__contract.mjs" <<'NODECONTRACT'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let failed = false;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed = true; };
// Resolution-level refusals we accept as "ESM-only / not exported".
const REFUSED = new Set(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_REQUIRE_ESM']);

// 1. The supported path: ESM import of a subpath resolves.
try { await import('pyric/firestore'); ok('import("pyric/firestore") resolves (supported ESM path)'); }
catch (e) { bad('import("pyric/firestore") should resolve but threw ' + (e?.code ?? e)); }

// 2. ESM-only: require() of that same subpath is refused (no require/default cond).
try { require('pyric/firestore'); bad('require("pyric/firestore") unexpectedly succeeded — ESM-only contract broken'); }
catch (e) { REFUSED.has(e?.code) ? ok('require("pyric/firestore") refused (' + e.code + ') — ESM-only enforced') : bad('require("pyric/firestore") threw unexpected ' + e?.code); }

// 3. Subpath-only: a bare specifier has no "." root export, either way.
try { await import('pyric'); bad('import("pyric") unexpectedly resolved — expected no root export'); }
catch (e) { e?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? ok('import("pyric") refused — no root export (subpath-only)') : bad('import("pyric") threw unexpected ' + e?.code); }
try { require('pyric'); bad('require("pyric") unexpectedly succeeded — expected no root export'); }
catch (e) { e?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? ok('require("pyric") refused — no root export (subpath-only)') : bad('require("pyric") threw unexpected ' + e?.code); }

if (failed) { console.error('module-system contract: FAIL'); process.exit(1); }
console.log('  ✓ module-system contract OK — ESM-only + subpath-only hold');
NODECONTRACT
( cd "$WORK/consumer" && node __contract.mjs )

# ─── Phase 6: cleanup on success ───────────────────────────────────────
echo ""
echo "━━━ Phase 6: cleanup ━━━"
rm -rf "$WORK"

trap - ERR
echo ""
echo "✓ packaging gate PASS — all 5 packages pack, install, and resolve every advertised subpath."
