#!/usr/bin/env bun
/**
 * Deploy playground to the `digame-mas` Firebase project, with
 * BOTH inference modes live in one shot:
 *
 *   1. the inference API as a Cloud Function Gen 2 (the Option C
 *      resumable-server-stream host)
 *   2. the static Astro client to the default Hosting site
 *   3. a Hosting rewrite `/api/** → inferenceApi` — the same-origin
 *      bridge that makes the resumable stream reachable without CORS
 *
 * Default SW streaming rides on the static deploy; the resumable
 * server stream rides on the function. One deploy, one origin, both.
 *
 * Driven entirely through `@pyric/deploy` — no firebase CLI.
 *
 * Pre-reqs:
 *   - `bun run build` has produced `dist/client/` and
 *     `functions/inference-api/lib/index.js`.
 *   - The `digame-mas` service-account JSON is reachable. Lookup
 *     order: `$DEPLOY_SA_PATH`, else a walk up to `ignored/
 *     digame-mas-service-account.json` (that dir lives in the main
 *     repo, not in git worktrees).
 *
 * Usage:
 *   bun run deploy
 *   DEPLOY_SA_PATH=/abs/path/sa.json bun run deploy
 */
import { fromServiceAccount, functions, hosting } from 'pyric-tools/deploy';
import { existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FUNCTION_ID = 'inferenceApi';
const FUNCTION_REGION = 'us-central1';

const __dirname = dirname(fileURLToPath(import.meta.url));
const playgroundRoot = resolve(__dirname, '..');
const clientDir = resolve(playgroundRoot, 'dist', 'client');
const functionDir = resolve(playgroundRoot, 'functions', 'inference-api');

/* ── locate the service account ─────────────────────────────────── */

function findServiceAccount(): string {
  if (process.env.DEPLOY_SA_PATH) return process.env.DEPLOY_SA_PATH;
  // The gitignored `ignored/` dir lives in the main repo; a git
  // worktree won't have it locally. Walk up until we find it.
  let dir = playgroundRoot;
  for (let i = 0; i < 10; i++) {
    const candidate = resolve(dir, 'ignored', 'digame-mas-service-account.json');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  console.error(
    'Could not find the digame-mas service account.\n' +
      'Set DEPLOY_SA_PATH to the SA JSON path, or place it at ignored/digame-mas-service-account.json.',
  );
  process.exit(1);
}

/* ── preflight ──────────────────────────────────────────────────── */

if (!existsSync(clientDir)) {
  console.error(`No dist/client/ at ${clientDir}. Run "bun run build" first.`);
  process.exit(1);
}
if (!existsSync(resolve(functionDir, 'lib', 'index.js'))) {
  console.error(
    `No built function at ${functionDir}/lib/index.js. Run "bun run build" first.`,
  );
  process.exit(1);
}

const saPath = findServiceAccount();
const scope = await fromServiceAccount(saPath);
console.log('');
console.log(`  project:  ${scope.projectId}`);

// Ship the service account inside the function bundle as sa.json.
// The function's RTDB client needs a JWT-minted token scoped to
// firebase.database — Cloud Run's metadata-server token can't provide
// that. Written fresh on every deploy; gitignored, never committed.
const fnSaPath = resolve(functionDir, 'sa.json');
copyFileSync(saPath, fnSaPath);
console.log(`  bundled SA → functions/inference-api/sa.json`);

/* ── 1. function first ──────────────────────────────────────────── */
// Hosting validates rewrite targets at finalize time, so the
// function must exist before the rewrite is deployed.

console.log(`  deploying function "${FUNCTION_ID}" (${FUNCTION_REGION})…`);
const fn = await functions.deployLocal(scope, {
  localDir: functionDir,
  functions: [
    {
      id: FUNCTION_ID,
      entryPoint: FUNCTION_ID,
      region: FUNCTION_REGION,
      // 1Gi (vs the 512Mi default) — bigger instance = larger code-
      // load cache + less GC pressure during streaming, which the
      // observed-cold-start probes showed cut first-byte time
      // materially. The function bundles its SA + the LLM adapters
      // statically, so 512Mi was tight under cold load. Plenty of
      // headroom at 1Gi; no measurable cost increase at this
      // function's traffic shape.
      memory: '1Gi',
      timeoutSeconds: 300,
      invoker: 'public',
      // Pinned to a single warm instance.
      //
      // Note: this is NOT the old `maxInstances: 1` state-locality
      // crutch the in-memory job-store needed (POST → stream →
      // reconnect all landing on one instance). The RTDB-backed
      // relay removed that requirement — any instance can serve any
      // reconnect (proved by the durability probe; see
      // plans/sw-inference-backgrounding-recovery.md, Option C).
      //
      // The pin is now a deliberate cost-vs-cold-start trade for a
      // single-developer playground:
      //   - `minInstances: 1` — keep one instance warm so the first
      //     request after idle doesn't pay the 2-5s Gen 2 cold start.
      //     Module init (SA load, @inbrowser/agent, @inbrowser/relay,
      //     provider adapters) is paid at instance boot, not at
      //     first-user request time.
      //   - `maxInstances: 1` — cap the bill. Concurrent users
      //     serialize on the one instance, but the playground's
      //     traffic shape (~1 user at a time) makes that theoretical.
      //
      // Companion Cloud Run service-level settings — set out-of-band
      // via `gcloud run services update inferenceapi --region
      // us-central1 --cpu=1 --no-cpu-throttling --concurrency=80`.
      // They persist on the service across deploys. Tracked in
      // GitHub issue #336: cpu / cpu-throttling / concurrency should
      // land on `FunctionDeployConfig` so the entire config is in
      // this file.
      //
      // Why each one matters here:
      //   - `cpu=1` — required when cpu-throttling is off
      //     (Cloud Run rejects "cpu always allocated" with cpu<1).
      //   - `--no-cpu-throttling` — keep CPU available while idle
      //     so first-request-after-idle doesn't pay the JIT
      //     warmup tax for the LLM adapter / SSE setup.
      //   - `--concurrency=80` — Cloud Run *Functions Gen 2* defaults
      //     containerConcurrency to 1, which means one request at a
      //     time per instance. With minInstances=maxInstances=1, that
      //     made the entire service single-flight: any two near-
      //     simultaneous requests (main agent loop + prompt-enhancer
      //     call, two browser tabs, the SSE reconnect path racing
      //     a fresh POST) returned 429 from Google's frontend.
      //     The 429 surfaces in the browser as a CORS error because
      //     the throttled response has no CORS headers (it's
      //     generated by the load balancer, not our handler). Cloud
      //     Run's *standard* default is 80; we pin to that.
      minInstances: 1,
      maxInstances: 1,
    },
  ],
});

let functionUrl: string | null = null;
if (!fn.success) {
  if (fn.error.code === 'IAM_GRANT_FAILED') {
    // The function deployed; only the public-invoker IAM grant
    // failed. It may still be reachable via the Hosting rewrite
    // (Hosting invokes it as an authenticated caller), so this is a
    // warning, not a hard stop.
    console.warn(
      '  ⚠ function deployed, but the public-invoker grant failed ' +
        '(IAM_GRANT_FAILED) — continuing; the /api rewrite may still reach it',
    );
  } else {
    console.error(`  ✗ function deploy failed: ${fn.error.code} — ${fn.error.message}`);
    if (fn.error.functionIndex !== undefined) {
      console.error(`    failed at function index ${fn.error.functionIndex}`);
    }
    process.exit(1);
  }
} else {
  for (const f of fn.data.deployed) {
    console.log(`  ✓ ${f.id} → ${f.uri} (public: ${f.publicInvoker})`);
    if (f.id === FUNCTION_ID) functionUrl = f.uri;
  }
}

/* ── 2. publish the function URL for the client ─────────────────── */
// The client talks to the function at its raw Cloud Run URL, not
// through the Hosting rewrite — Firebase Hosting buffers SSE
// responses end-to-end, so the rewrite can't stream. We write the URL
// as a static file the client fetches once at startup
// (server-client.ts → resolveApiBase). It goes into the already-built
// dist/client/ so the hosting deploy below uploads it.

const endpointFile = resolve(clientDir, 'inference-endpoint.json');
if (functionUrl) {
  writeFileSync(endpointFile, `${JSON.stringify({ url: functionUrl })}\n`);
  console.log(`  ✓ inference endpoint → ${functionUrl}`);
} else {
  console.warn(
    '  ⚠ no function URL captured — client will fall back to the (buffered) Hosting rewrite',
  );
}

/* ── 3. static client + the /api rewrite ────────────────────────── */
// Default Hosting site id == project id. The /api/** rewrite stays as
// a same-origin fallback for when /inference-endpoint.json can't be
// read; the streaming path is the direct Cloud Run URL above.

console.log(`  deploying hosting to site "${scope.projectId}" with /api/** rewrite…`);
const host = await hosting.deployFiles(scope, {
  siteId: scope.projectId,
  localDir: clientDir,
  rewrites: [
    {
      source: '/api/**',
      function: { functionId: FUNCTION_ID, region: FUNCTION_REGION },
    },
  ],
});

if (!host.success) {
  console.error(`  ✗ hosting deploy failed: ${host.error.code} — ${host.error.message}`);
  process.exit(1);
}

console.log('');
console.log(`  ✓ deployed ${host.data.uploadedCount}/${host.data.fileCount} files`);
console.log(`  ✓ version:  ${host.data.versionName}`);
console.log(`  ✓ release:  ${host.data.releaseName}`);
console.log(`  ✓ live at:  ${host.data.hostingUrl}`);
console.log('');
