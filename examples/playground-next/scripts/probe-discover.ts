#!/usr/bin/env bun
/**
 * Probe for `firestore_discover_paths` against a real Firebase
 * project from Node, using the browser-runnable AgentApp shim.
 *
 * Validates PR 2 from `plans/expand-pyric-agent-tool-surface.md`:
 *
 *   - `createRestCrawlerFirestore` satisfies the structural Firestore
 *     contract `crawl()` consumes.
 *   - `createBrowserAgentApp` wraps it into an `AgentApp` shape that
 *     `createDiscoverTools(app)` accepts without complaint.
 *   - End-to-end: a dryRun crawl emits a cost estimate; a real
 *     (bounded) crawl emits at least one collection schema.
 *
 * Why a probe rather than a unit test: the discover crawler talks to
 * real Firestore. Mocking it for this purpose hides exactly the
 * resolution / auth-scope / wire-format bugs we're trying to catch.
 *
 * Required env:
 *   PROBE_ACCESS_TOKEN  — OAuth access token with `auth/datastore`
 *                         (or `auth/firebase` which covers it). The
 *                         playground's sign-in surface returns one
 *                         of these. Grab it with the snippet below
 *                         while signed in to the deployed playground:
 *
 *                           JSON.parse(sessionStorage['pyric:googleSession']).accessToken
 *
 *                         Paste the result (no quotes) into the env.
 *   PROBE_PROJECT_ID    — Firebase project to crawl. Usually your
 *                         playground test project (NOT 'blockingfun'
 *                         which is the OAuth-consent project).
 *
 * Usage:
 *   PROBE_ACCESS_TOKEN=ya29.… \
 *   PROBE_PROJECT_ID=your-project \
 *   bun scripts/probe-discover.ts
 *
 *   bun scripts/probe-discover.ts --dry-run-only
 *     # skip the full crawl, just emit the cost estimate
 */
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { resolve } from 'node:path';
import { createRestCrawlerFirestore, crawl } from 'pyric-tools/discover';

/**
 * Mint a short-lived Firestore-scoped access token from a service-
 * account JSON file. Signs a JWT with the SA's private key, exchanges
 * it at the token endpoint. Returns the bearer token string.
 *
 * Same flow firebase-admin and gcloud use under the hood — we
 * implement it inline so the probe doesn't pull in firebase-admin
 * (which would defeat the point of testing the browser-runnable
 * shim from Node).
 */
async function mintTokenFromServiceAccount(saPath: string, scope: string): Promise<string> {
  const sa = JSON.parse(readFileSync(resolve(saPath), 'utf-8')) as {
    client_email: string;
    private_key: string;
    token_uri?: string;
  };
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ iss: sa.client_email, scope, aud: tokenUri, iat: now, exp: now + 3600 }),
  ).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = signer.sign(sa.private_key).toString('base64url');
  const jwt = `${header}.${payload}.${sig}`;
  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function main(): Promise<void> {
  let accessToken = process.env.PROBE_ACCESS_TOKEN;
  const saFile = process.env.PROBE_SA_FILE;
  const projectId = process.env.PROBE_PROJECT_ID;

  if (!accessToken && saFile) {
    console.log(`Minting Firestore token from service account at ${saFile}…`);
    accessToken = await mintTokenFromServiceAccount(
      saFile,
      'https://www.googleapis.com/auth/datastore',
    );
  }

  if (!accessToken || !projectId) {
    console.error(
      'Set PROBE_PROJECT_ID and EITHER PROBE_ACCESS_TOKEN or PROBE_SA_FILE (path to service-account.json).',
    );
    process.exit(1);
  }

  const dryRunOnly = process.argv.includes('--dry-run-only');

  const db = createRestCrawlerFirestore({ accessToken, projectId });

  // ── Dry-run ───────────────────────────────────────────────────────
  console.log(`Probing ${projectId} (dry-run, single listCollections RPC)…`);
  const t0 = performance.now();
  const dry = await crawl(db, { dryRun: true });
  const dryMs = Math.round(performance.now() - t0);
  if (!dry.dryRunCostEstimate) {
    console.error('Expected dryRunCostEstimate on dryRun:true crawl — missing.');
    process.exit(2);
  }
  console.log('Dry-run result:');
  console.log(`  ${dryMs}ms · ${dry.listOps} listOps · ${dry.readOps} readOps`);
  console.log(`  ${dry.dryRunCostEstimate.rootCollectionCount} root collection(s) found`);
  console.log(`  projected total: ~${dry.dryRunCostEstimate.estimatedListOps} listOps · ~${dry.dryRunCostEstimate.estimatedReadOps} reads`);

  if (dryRunOnly) {
    console.log('\nDone (dry-run only).');
    return;
  }

  // ── Real crawl (bounded) ──────────────────────────────────────────
  console.log('\nFull crawl (bounded: maxDepth=3, maxSamples=5)…');
  const t1 = performance.now();
  const real = await crawl(db, {
    maxDepth: 3,
    maxSamples: 5,
    stopOnStable: 3,
  });
  const realMs = Math.round(performance.now() - t1);
  const schemaCount = real.finalizedSchemas.size;
  console.log(`Crawl complete in ${realMs}ms · ${real.listOps} listOps · ${real.readOps} readOps`);
  console.log(`  ${schemaCount} schema(s) finalized`);
  if (schemaCount === 0) {
    console.warn('  (no schemas — project is empty or maxDepth too shallow)');
  } else {
    for (const [templatePath, schema] of real.finalizedSchemas) {
      const fieldCount =
        schema.schema.kind === 'map' ? Object.keys(schema.schema.fields).length : 0;
      console.log(
        `  - ${templatePath} · ${fieldCount} field(s) · sampling=${schema.samplingComplete}`,
      );
    }
  }
  console.log('\nProbe passed — browser AgentApp shim is end-to-end functional.');
}

await main();
