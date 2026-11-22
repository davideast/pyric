/**
 * Named-database capture, replay, case derivation, and `pyric verify` tests:
 * - `.pyric/last-session.json` (`buildLiveSessionCaptureFixture` / `buildVerifyFixture`)
 *   records each request's `database` and `services.firestore.{declared,databases}`
 * - `verifyFixture` evaluates each database's events against its own candidate rules
 * - `pyric verify` resolves `firebase.json` `firestore` array + `.firebaserc` targets
 *   and `--rules firestore:<database>=<path>`.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doc, getDoc, getFirestore as getClientFirestore, setDoc } from 'pyric/firestore';
import { declareFirestoreDatabase, getDatabaseEnv } from 'pyric/firestore/internal';
import { initializeSandbox } from 'pyric/sandbox';

import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerify } from '../../src/cli/verify.js';
import { buildLiveSessionCaptureFixture } from '../../src/serve/session-capture-fixture.js';
import {
  deriveRulesTestCases,
  recordedFirestoreDatabases,
  recordsDefaultFirestoreDatabase,
  verifyFixture,
} from '../../src/verify/index.js';

const DEFAULT_ALICE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

const REPORTS_BOB_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read, write: if request.auth.uid == 'bob';
    }
  }
}`;

const DENY_ALL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const dirs: string[] = [];

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pyric-verify-named-db-'));
  dirs.push(dir);
  return dir;
}

async function runVerifyIn(dir: string, argv: string[]): Promise<number> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await runVerify(parseArgs(['verify', ...argv]));
  } finally {
    process.chdir(prev);
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('named Firestore databases in session captures and pyric verify', () => {
  it('captures per-database events and state and verifies each database under its own rules', async () => {
    const sandbox = initializeSandbox();
    declareFirestoreDatabase(sandbox, 'reports');
    declareFirestoreDatabase(sandbox, 'unused-db');
    getDatabaseEnv(sandbox).deployRules(DEFAULT_ALICE_RULES);
    getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_BOB_RULES);

    const aliceDefault = getClientFirestore(sandbox.withAuth({ uid: 'alice' }));
    const bobReports = getClientFirestore(sandbox.withAuth({ uid: 'bob' }), 'reports');
    const aliceReports = getClientFirestore(sandbox.withAuth({ uid: 'alice' }), 'reports');

    await setDoc(doc(aliceDefault, 'items/shared'), { plane: 'default' });
    await setDoc(doc(bobReports, 'items/shared'), { plane: 'reports' });
    await expect(getDoc(doc(aliceReports, 'items/shared'))).rejects.toThrow();

    const capture = buildLiveSessionCaptureFixture({
      sandbox,
      authState: { users: [], currentUser: null },
    });

    expect(capture.services.firestore?.declared).toEqual(['reports', 'unused-db']);
    expect(recordedFirestoreDatabases(capture)).toEqual(['reports']);
    expect(recordsDefaultFirestoreDatabase(capture)).toBe(true);

    const defaultCases = deriveRulesTestCases(capture, { database: '(default)' });
    const reportsCases = deriveRulesTestCases(capture, { database: 'reports' });
    expect(defaultCases.derived.every((d) => d.database === undefined)).toBe(true);
    expect(reportsCases.derived.every((d) => d.database === 'reports')).toBe(true);
    expect(reportsCases.testCases.some((c) => c.expectation === 'DENY')).toBe(true);

    const clean = await verifyFixture(capture, {
      rules: {
        firestore: DEFAULT_ALICE_RULES,
        firestoreDatabases: { reports: REPORTS_BOB_RULES },
      },
    });
    expect(clean.ok).toBe(true);
    expect(clean.services.firestore?.divergences).toEqual([]);

    const skipped = await verifyFixture(capture, {
      rules: { firestore: DEFAULT_ALICE_RULES },
    });
    expect(skipped.ok).toBe(true);
    expect(skipped.services.firestore?.skippedDatabases).toEqual(['reports']);

    const regressedReports = await verifyFixture(capture, {
      rules: {
        firestore: DEFAULT_ALICE_RULES,
        firestoreDatabases: { reports: DENY_ALL_RULES },
      },
    });
    expect(regressedReports.ok).toBe(false);
    const reportsDivs = regressedReports.services.firestore?.divergences ?? [];
    expect(reportsDivs.length).toBeGreaterThan(0);
    expect(reportsDivs.every((d) => d.database === 'reports')).toBe(true);
  });

  it('resolves firebase.json firestore array, .firebaserc targets, and --rules firestore:<database>=<path>', async () => {
    const sandbox = initializeSandbox();
    declareFirestoreDatabase(sandbox, 'reports');
    getDatabaseEnv(sandbox).deployRules(DEFAULT_ALICE_RULES);
    getDatabaseEnv(sandbox, 'reports').deployRules(REPORTS_BOB_RULES);

    await setDoc(
      doc(getClientFirestore(sandbox.withAuth({ uid: 'alice' })), 'items/shared'),
      { owner: 'alice' },
    );
    await setDoc(
      doc(getClientFirestore(sandbox.withAuth({ uid: 'bob' }), 'reports'), 'items/shared'),
      { owner: 'bob' },
    );
    const capture = buildLiveSessionCaptureFixture({
      sandbox,
      authState: { users: [], currentUser: null },
    });

    const dir = makeTempProject();
    mkdirSync(join(dir, '.pyric'), { recursive: true });
    writeFileSync(join(dir, '.pyric', 'last-session.json'), JSON.stringify(capture));
    writeFileSync(
      join(dir, '.firebaserc'),
      JSON.stringify({
        projects: { default: 'demo-proj' },
        targets: { 'demo-proj': { firestore: { reporting: ['reports'] } } },
      }),
    );
    writeFileSync(
      join(dir, 'firebase.json'),
      JSON.stringify({
        firestore: [
          { database: '(default)', rules: 'firestore.default.rules' },
          { target: 'reporting', rules: 'reports.rules' },
        ],
      }),
    );
    writeFileSync(join(dir, 'firestore.default.rules'), DEFAULT_ALICE_RULES);
    writeFileSync(join(dir, 'reports.rules'), REPORTS_BOB_RULES);
    writeFileSync(join(dir, 'strict-reports.rules'), DENY_ALL_RULES);

    expect(await runVerifyIn(dir, [])).toBe(0);
    expect(await runVerifyIn(dir, ['--rules', 'firestore:reports=strict-reports.rules'])).toBe(1);
    expect(await runVerifyIn(dir, ['--rules', 'firestore:never-used=reports.rules'])).toBe(2);
  });
});
