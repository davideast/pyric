import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import {
  doc,
  getAdminFirestore,
  getDoc,
  getFirestore,
  onSnapshot,
  setDoc,
  terminate,
} from 'pyric/firestore';
import { expectReplay, load } from './support.ts';

const LOCKED_RULES = [
  "rules_version = '2';",
  'service cloud.firestore {',
  '  match /databases/{database}/documents {',
  '    match /{document=**} { allow read, write: if false; }',
  '  }',
  '}',
].join('\n');

interface AbsentObservationFile {
  readonly diagnostics: Readonly<Record<string, { readonly databaseId?: string }>>;
}

const OBS_PATH = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'conformance',
  'observations',
  'firestore',
  'firestore-named-database-absent.json',
);

function errorCodeOf(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const raw = (err as { code?: unknown }).code;
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number') return String(raw);
  }
  return 'unknown';
}

function adminErrorOutcome(err: unknown): string {
  const code = errorCodeOf(err);
  if (code === 'not-found' || code === '5') return 'error:5';
  return `error:${code}`;
}

describe('Firestore named-database absent-database oracle capture (ADR-0021 C3)', () => {
  it('replays client and admin behaviors in firestore-named-database-absent (firestore#MD1)', async () => {
    const production = load('firestore-named-database-absent');
    const raw = JSON.parse(readFileSync(OBS_PATH, 'utf8')) as AbsentObservationFile;

    const sandbox = initializeSandbox({ projectId: 'demo-named-db-absent' });
    setRules(sandbox, LOCKED_RULES);
    setRules(sandbox, LOCKED_RULES, 'probes');

    const probePath = '__pyric_named_db_probe/replay';
    const sdkProduction: Record<string, string> = {};
    const actual: Record<string, string> = {};

    try {
      for (const [key, value] of Object.entries(production)) {
        // REST HTTP status codes are exercised on the hosted HTTP plane, not the in-page SDK.
        if (key.endsWith(':rest')) continue;
        sdkProduction[key] = String(value);
      }

      const absentLabels = ['absent-valid-id', 'absent-invalid-id', 'keyword-default'] as const;
      for (const label of absentLabels) {
        const databaseId = raw.diagnostics[label]?.databaseId;
        if (databaseId === undefined) {
          throw new Error(`Missing databaseId diagnostic for ${label}`);
        }
        const clientDb = getFirestore(sandbox.withAuth(null), databaseId);
        const adminDb = getAdminFirestore(sandbox, databaseId);

        try {
          await getDoc(doc(clientDb, probePath));
          actual[`${label}:client`] = 'missing';
        } catch (err) {
          actual[`${label}:client`] = `error:${errorCodeOf(err)}`;
        }

        try {
          const snap = await getDoc(doc(adminDb, probePath));
          actual[`${label}:admin`] = snap.exists() ? 'exists' : 'missing';
        } catch (err) {
          actual[`${label}:admin`] = adminErrorOutcome(err);
        }

        const firstSnap = await new Promise<{ fromCache: boolean; exists: boolean }>(
          (resolve, reject) => {
            const unsub = onSnapshot(
              doc(clientDb, probePath),
              (snap) => {
                unsub();
                resolve({ fromCache: snap.metadata.fromCache, exists: snap.exists() });
              },
              reject,
            );
          },
        );
        actual[`${label}:client-onSnapshot`] =
          `snapshot:fromCache=${firstSnap.fromCache}:exists=${firstSnap.exists}`;

        let settled = false;
        const pendingWrite = setDoc(doc(clientDb, probePath), { waiting: true }).then(
          () => { settled = true; },
          () => { settled = true; },
        );
        await new Promise((r) => setTimeout(r, 25));
        actual[`${label}:client-setDoc`] = settled ? 'settled' : 'timeout';
        await terminate(clientDb);
        void pendingWrite;

        try {
          await setDoc(doc(adminDb, probePath), { shouldFail: true });
          actual[`${label}:admin-set`] = 'ok';
        } catch (err) {
          actual[`${label}:admin-set`] = adminErrorOutcome(err);
        }
      }

      for (const label of ['control-default', 'control-probes'] as const) {
        const databaseId = raw.diagnostics[label]?.databaseId;
        if (databaseId === undefined) {
          throw new Error(`Missing databaseId diagnostic for ${label}`);
        }
        const clientDb = getFirestore(sandbox.withAuth(null), databaseId);
        const adminDb = getAdminFirestore(sandbox, databaseId);

        try {
          await getDoc(doc(clientDb, probePath));
          actual[`${label}:client`] = 'missing';
        } catch (err) {
          actual[`${label}:client`] = `error:${errorCodeOf(err)}`;
        }

        const adminSnap = await getDoc(doc(adminDb, probePath));
        actual[`${label}:admin`] = adminSnap.exists() ? 'exists' : 'missing';
      }

      expect(Object.keys(actual).length).toBe(19);
      expectReplay({ production: sdkProduction, pyric: actual });
    } finally {
      sandbox.dispose();
    }
  });
});
