#!/usr/bin/env bun
/**
 * How production Firestore and Storage rules evaluate a real ID token's claim
 * set as `request.auth`, per sign-in kind, through the Rules Test API.
 *
 * The claim shapes come from the production capture
 * `observations/auth/auth-request-auth-per-sign-in.json` (decoded tokens from
 * real sign-ins). Placeholders are filled with fixed synthetic values (see
 * `fill`), so every case is reproducible and names no real account. Each
 * session's probes (`auth-request-auth-probes.ts`) and CEL type checks
 * (`request.auth.token.iat is int`, ...) run as one ruleset per service. The Test API binds whatever token a case sends, so this
 * shows how production's evaluator reads a real token's claims (their CEL
 * types, nested maps and lists), not which claims production adds; the RTDB
 * capture answers that.
 *
 * Nothing is deployed. Credentials resolve as for the parity packs
 * (`packages/pyric/test/rules/parity/credential.ts`): with none, the script is
 * inert.
 *
 *   bun run packages/conformance/src/capture-auth-request-auth-rules-test-api.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasParityCredential, parityScope } from '../../pyric/test/rules/parity/credential.ts';
import { probesFor, type Claims } from './auth-request-auth-probes.ts';
import { resolvedFirebaseVersion } from './package-version.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = resolve(HERE, '../observations/auth/auth-request-auth-per-sign-in.json');
const OUT = resolve(HERE, '../observations/auth/auth-request-auth-rules-test-api.json');
const RULES_API = 'https://firebaserules.googleapis.com/v1';

/** Synthetic values for the capture's placeholders. Times are fixed so the cases never change. */
export const SYNTHETIC = {
  uid: 'hunt-auth-uid',
  email: 'hunt-auth@example.com',
  phoneNumber: '+15551234567',
  projectId: 'digame-mas',
  prefix: 'pyric-hunt-auth-x',
  iat: 1_793_000_000,
  authTime: 1_792_999_940,
  level: 5,
  ratio: 1.5,
};

/** A recorded claim shape with its placeholders replaced by {@link SYNTHETIC} values. */
export function fill(shape: unknown, key = ''): unknown {
  if (Array.isArray(shape)) return shape.map((v) => fill(v, key));
  if (shape && typeof shape === 'object') return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, fill(v, k)]));
  if (shape === '<int>') {
    if (key === 'iat') return SYNTHETIC.iat;
    if (key === 'exp') return SYNTHETIC.iat + 3600;
    if (key === 'auth_time') return SYNTHETIC.authTime;
    return key === 'level' ? SYNTHETIC.level : 2;
  }
  if (shape === '<float>') return SYNTHETIC.ratio;
  if (typeof shape === 'string') {
    return shape.replaceAll('<email>', SYNTHETIC.email).replaceAll('<uid>', SYNTHETIC.uid).replaceAll('<phoneNumber>', SYNTHETIC.phoneNumber)
      .replaceAll('<projectId>', SYNTHETIC.projectId).replaceAll('<prefix>', SYNTHETIC.prefix);
  }
  return shape;
}

interface RecordedSession { claims?: unknown; signInProvider?: string | null; signInError?: string }

/** One session's Rules Test API input: the ruleset source, the cases, and the probe labels in order. */
export function sessionSuite(service: 'firestore' | 'storage', session: RecordedSession) {
  const claims = session.claims ? fill(session.claims) as Claims : null;
  const uid = claims ? SYNTHETIC.uid : null;
  const probes = probesFor(uid, claims, session.signInProvider ?? null).filter((p) => p.cel !== null);
  const matches = probes.map((p, i) => `    match /p${i}/{doc} { allow get: if ${p.cel}; }`).join('\n');
  const source = service === 'firestore'
    ? `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${matches}\n  }\n}\n`
    : `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n${matches}\n  }\n}\n`;
  // A signed-out case sends `auth: null`. With auth omitted, the Test API
  // leaves request.auth undefined ("Property auth is undefined on object"), so
  // `request.auth == null` errors, where a real signed-out request reads null.
  const auth = uid === null ? { auth: null } : { auth: { uid, token: claims } };
  const testCases = probes.map((_, i) => service === 'firestore'
    ? { expectation: 'ALLOW', request: { ...auth, method: 'get', path: `/databases/(default)/documents/p${i}/d` } }
    : { expectation: 'ALLOW', request: { ...auth, method: 'get', path: `/b/${SYNTHETIC.projectId}.appspot.com/o/p${i}/o` } });
  return { source, testCases, labels: probes.map((p) => p.label), claims, uid };
}

if (import.meta.main) {
  if (!hasParityCredential()) {
    console.log('[oracle:auth-request-auth-test-api] inert: no Rules Test API credential.');
    process.exit(0);
  }
  const scope = parityScope();
  const recorded = JSON.parse(readFileSync(SOURCE, 'utf8')) as { behavior: Record<string, RecordedSession>; observedAt: string };
  const behavior: Record<string, unknown> = {};
  for (const [kind, session] of Object.entries(recorded.behavior)) {
    if (kind === 'admin' || kind === 'cleanup' || session.signInError) continue;
    const out: Record<string, unknown> = {};
    for (const service of ['firestore', 'storage'] as const) {
      const { source, testCases, labels } = sessionSuite(service, session);
      const res = await fetch(`${RULES_API}/projects/${scope.projectId}:test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await scope.resolveToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: { files: [{ name: `${service}.rules`, content: source }] }, testSuite: { testCases } }),
      });
      if (!res.ok) throw new Error(`Rules Test API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json() as { issues?: { description: string }[]; testResults?: { state?: string }[] };
      const verdicts: Record<string, unknown> = {};
      labels.forEach((label, i) => {
        const r = data.testResults?.[i];
        verdicts[label] = r?.state === 'SUCCESS' ? 'ALLOW' : 'DENY';
      });
      if (data.issues?.length) verdicts.issues = data.issues.map((x) => x.description);
      out[service] = verdicts;
    }
    behavior[kind] = out;
    console.log(`  ${kind}: done`);
  }
  writeFileSync(OUT, `${JSON.stringify({
    name: 'auth-request-auth-rules-test-api',
    matrixRow: 'auth #68c',
    rowIds: ['auth#68c'],
    description: `Production Firestore and Storage rules (Rules Test API, nothing deployed) evaluating each sign-in kind's real decoded ID token claim set as request.auth: equality and type probes on every claim (iat, exp and auth_time as int, email_verified as bool, developer claims as int, float, list and map, firebase.identities as a map of lists), sub and user_id against uid, iss against aud, exp minus iat; a signed-out case sends auth null. Claim shapes come from auth-request-auth-per-sign-in (observed ${recorded.observedAt}); placeholders are filled with fixed synthetic values.`,
    observedAt: new Date().toISOString(),
    fbSdkVersion: resolvedFirebaseVersion(),
    projectId: scope.projectId,
    behavior,
  }, null, 2)}\n`);
  console.log(`[oracle:auth-request-auth-test-api] wrote ${OUT}`);
}
