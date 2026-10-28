#!/usr/bin/env bun
/**
 * RTDB staging auth-override capture: does production evaluate rules with the
 * exact `auth` object an admin request passes as its auth override, nested
 * `auth.token` claims included? `pyric verify --engine staging` runs every
 * captured operation as its user this way, through the REST
 * `auth_variable_override` parameter; firebase-admin's
 * `databaseAuthVariableOverride` is captured alongside as a control.
 *
 * Two runs over eight rule fields (`auth.uid`, `auth.provider`,
 * `auth.token.firebase.sign_in_provider`, `auth.token.firebase.tenant`,
 * `auth.token.email`, `auth.token.email_verified`, a custom claim, and
 * `auth == null`): matching, mismatching and signed-out identities; then the
 * matching identity with exactly one claim changed at a time, where only that
 * field may be denied. Writes only.
 *
 * Safety: runs only against an empty instance; snapshots its rules, deploys
 * the probe rules, removes /probe, restores the exact prior rules text, and
 * reads both back, writing the observation only when both invariants hold.
 *
 * Inert unless PYRIC_STAGING_RTDB (database URL) is set. The OAuth token
 * comes from PYRIC_STAGING_TOKEN, else the Firebase CLI login.
 *
 *   PYRIC_STAGING_RTDB=https://<instance>.firebaseio.com \
 *     bun run packages/conformance/src/capture-rtdb-staging-auth-override.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const URL_ = (process.env.PYRIC_STAGING_RTDB ?? '').replace(/\/+$/, '');
if (URL_ === '') {
  console.log('[oracle:rtdb-staging-auth-override] inert: set PYRIC_STAGING_RTDB to an empty, dedicated instance URL to capture.');
  process.exit(0);
}
const INSTANCE = new URL(URL_).hostname.split('.')[0];
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../observations/rtdb-modular/rtdb-modular-staging-auth-override.json');
const ADMIN_VERSION = JSON.parse(readFileSync(resolve(HERE, '../../../node_modules/firebase-admin/package.json'), 'utf8')).version;
// firebase-tools keeps its login where the `configstore` package puts it: $XDG_CONFIG_HOME, else ~/.config.
const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config');
const token = process.env.PYRIC_STAGING_TOKEN
  ?? JSON.parse(readFileSync(join(configHome, 'configstore', 'firebase-tools.json'), 'utf8')).tokens.access_token;
const H = { Authorization: `Bearer ${token}` };

const PROBE_RULES = {
  rules: {
    '.read': false,
    '.write': false,
    probe: {
      uid: { '.write': "auth != null && auth.uid == 'alice'" },
      provider: { '.write': "auth != null && auth.provider == 'password'" },
      sign_in_provider: { '.write': "auth != null && auth.token.firebase.sign_in_provider == 'password'" },
      tenant: { '.write': "auth != null && auth.token.firebase.tenant == 'tenant-a'" },
      email: { '.write': "auth != null && auth.token.email == 'alice@example.com'" },
      email_verified: { '.write': 'auth != null && auth.token.email_verified == true' },
      custom_claim: { '.write': 'auth != null && auth.token.admin == true' },
      signed_out: { '.write': 'auth == null' },
    },
  },
};
const MATCH = {
  uid: 'alice', provider: 'password',
  token: { email: 'alice@example.com', email_verified: true, admin: true, firebase: { sign_in_provider: 'password', tenant: 'tenant-a' } },
};
const MISMATCH = {
  uid: 'bob', provider: 'anonymous',
  token: { email: 'bob@example.com', email_verified: false, admin: false, firebase: { sign_in_provider: 'anonymous', tenant: 'tenant-b' } },
};
const FIELDS = Object.keys(PROBE_RULES.rules.probe);
// Isolation: MATCH with exactly one claim changed; only that field should be denied.
type Identity = typeof MATCH;
const flip = (mutate: (id: Identity) => void): Identity => { const id = structuredClone(MATCH); mutate(id); return id; };
const FLIPS: Array<[string, Identity]> = [
  ["flip_uid", flip((id) => { id.uid = "bob"; })],
  ["flip_provider", flip((id) => { id.provider = "anonymous"; })],
  ["flip_sign_in_provider", flip((id) => { id.token.firebase.sign_in_provider = "anonymous"; })],
  ["flip_tenant", flip((id) => { id.token.firebase.tenant = "tenant-b"; })],
  ["flip_email", flip((id) => { id.token.email = "bob@example.com"; })],
  ["flip_email_verified", flip((id) => { id.token.email_verified = false; })],
  ["flip_custom_claim", flip((id) => { id.token.admin = false; })],
];
// Expected verdicts: MATCH allows every field but signed_out; MISMATCH allows none; null allows only signed_out.
const expected = (identity: string, field: string): boolean =>
  identity.startsWith("flip_") ? field !== "signed_out" && field !== identity.slice(5) :
  identity === 'null' ? field === 'signed_out' : identity === 'match' ? field !== 'signed_out' : false;

async function rest(method: string, path: string, body?: unknown, query = ""): Promise<{ status: number; text: string }> {
  const res = await fetch(`${URL_}/${path}${query}`, { method, headers: H, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

interface CaptureCase {
  mechanism: string;
  identity: string;
  field: string;
  expected: string;
  observed: string;
  status?: number;
  body?: string;
  detail?: string;
}
const results: {
  instance: string;
  startedAt: string;
  finishedAt?: string;
  dryRun?: { status: number; text: string };
  cases: CaptureCase[];
  invariants: { dataRemoved?: boolean; rulesRestored?: boolean };
} = { instance: INSTANCE, startedAt: new Date().toISOString(), cases: [], invariants: {} };
const prior = await rest('GET', '.settings/rules.json');
if (prior.status !== 200) throw new Error(`cannot read rules: ${prior.status}`);
const priorRoot = await rest('GET', '.json', undefined, '?shallow=true');
if (priorRoot.text !== 'null') throw new Error(`refusing: ${INSTANCE} is not empty (${priorRoot.text.slice(0, 80)})`);

let failure: Error | undefined;
try {
  const dry = await rest('PUT', '.settings/rules.json', PROBE_RULES, '?dryRun=true');
  results.dryRun = dry;
  if (dry.status !== 200) throw new Error(`probe rules rejected by dry run: ${dry.text}`);
  const deployed = await rest('PUT', '.settings/rules.json', PROBE_RULES);
  if (deployed.status !== 200) throw new Error(`deploy failed: ${deployed.text}`);

  const identities: Record<string, Identity | null> = { match: MATCH, mismatch: MISMATCH, null: null, ...Object.fromEntries(FLIPS) };
  // Control: admin with no override bypasses rules.
  const adminCtl = await rest('PUT', 'probe/admin_control.json', '"x"');
  results.cases.push({ mechanism: 'rest', identity: 'admin-no-override', field: 'admin_control', expected: 'ALLOW', observed: adminCtl.status === 200 ? 'ALLOW' : 'DENY', status: adminCtl.status });

  for (const [name, identity] of Object.entries(identities)) {
    // (b) REST auth_variable_override
    for (const field of FIELDS) {
      const q = `?auth_variable_override=${encodeURIComponent(JSON.stringify(identity))}`;
      const r = await rest('PUT', `probe/${field}/rest_${name}.json`, '"v"', q);
      results.cases.push({ mechanism: 'rest', identity: name, field, expected: expected(name, field) ? 'ALLOW' : 'DENY', observed: r.status === 200 ? 'ALLOW' : r.status === 401 || r.status === 403 ? 'DENY' : `HTTP ${r.status}`, status: r.status, ...(r.status !== 200 ? { body: r.text.slice(0, 120) } : {}) });
    }
    // (a) firebase-admin databaseAuthVariableOverride
    const app = initializeApp({
      credential: { getAccessToken: async () => ({ access_token: token, expires_in: 1800 }) },
      databaseURL: URL_,
      databaseAuthVariableOverride: identity,
    }, `probe-${name}`);
    const db = getDatabase(app);
    for (const field of FIELDS) {
      let observed: string;
      let detail: string | undefined;
      try {
        await Promise.race([db.ref(`probe/${field}/admin_${name}`).set('v'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
        observed = 'ALLOW';
      } catch (e: unknown) {
        const error = e as { code?: unknown; message?: unknown };
        observed = /permission/i.test(String(error?.code ?? error?.message)) ? 'DENY' : 'ERROR';
        detail = String(error?.message ?? e).slice(0, 120);
      }
      results.cases.push({ mechanism: 'admin-sdk', identity: name, field, expected: expected(name, field) ? 'ALLOW' : 'DENY', observed, ...(detail ? { detail } : {}) });
    }
    await deleteApp(app);
  }
} catch (e: unknown) {
  failure = e instanceof Error ? e : new Error(String(e));
} finally {
  const del = await rest('DELETE', 'probe.json');
  const restore = await rest('PUT', '.settings/rules.json', prior.text);
  const back = await rest('GET', '.settings/rules.json');
  const root = await rest('GET', '.json', undefined, '?shallow=true');
  results.invariants = {
    dataRemoved: del.status === 200 && root.text === 'null',
    rulesRestored: restore.status === 200 && back.text === prior.text,
  };
  results.finishedAt = new Date().toISOString();
  if (!failure && results.invariants.dataRemoved && results.invariants.rulesRestored) {
    const fields = Object.keys(PROBE_RULES.rules.probe);
    writeFileSync(OUT, `${JSON.stringify({
      name: 'rtdb-modular-staging-auth-override',
      matrixRow: 'rtdb-modular#VR4',
      rowIds: ['rtdb-modular#VR4'],
      description: 'An admin request with an auth override, through the REST auth_variable_override parameter and through firebase-admin databaseAuthVariableOverride, writes to eight rule-gated paths of a dedicated instance as a matching, a mismatching and a signed-out identity, then as the matching identity with exactly one claim changed at a time. Production applies the override as the rules auth variable, auth.token claims included (firebase.sign_in_provider and firebase.tenant, which a custom token cannot carry), and denies only the field whose claim changed.',
      observedAt: results.finishedAt,
      adminSdkVersion: ADMIN_VERSION,
      projectId: process.env.PYRIC_STAGING_PROJECT ?? 'unrecorded',
      behavior: {
        rules: PROBE_RULES,
        identities: { match: MATCH, mismatch: MISMATCH, flips: Object.fromEntries(FLIPS) },
        fields,
        cases: results.cases,
        allMatchExpectation: results.cases.every((c) => c.observed === c.expected),
        invariants: results.invariants,
      },
    }, null, 2)}\n`);
  }
  if (!results.invariants.dataRemoved || !results.invariants.rulesRestored) {
    console.error('INVARIANT FAILED', results.invariants, { restoreStatus: restore.status, root: root.text.slice(0, 80) });
    process.exitCode = 3;
  }
}
if (failure) { console.error('capture failed:', failure.message); process.exitCode ||= 1; }
const mismatches = results.cases.filter((c) => c.observed !== c.expected);
console.log(`cases: ${results.cases.length}, matching expectation: ${results.cases.length - mismatches.length}, invariants: ${JSON.stringify(results.invariants)}`);
for (const c of results.cases) console.log(`${c.mechanism.padEnd(9)} ${c.identity.padEnd(17)} ${c.field.padEnd(17)} expected ${c.expected.padEnd(5)} observed ${c.observed}${c.observed !== c.expected ? '   <-- differs' : ''}`);
if (results.cases.some((c) => c.observed !== c.expected)) process.exitCode ||= 4;
process.exit(process.exitCode ?? 0);
