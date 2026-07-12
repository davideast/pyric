import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase, ref, set, sandbox as rtdbSandbox } from 'pyric/database';
import { getFirestore } from 'pyric/sandbox/admin-firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { buildVerifyFixture, type PyricVerifyFixture } from '../../src/verify/index.js';
import { parseArgs } from '../../src/cli/parse-args.js';
import { runVerify, type VerifyCliDeps } from '../../src/cli/verify.js';

const ALICE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;

const DENY_ALL_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if false; }
  }
}`;

const RTDB_MEMBER_RULES = {
  rules: {
    rooms: {
      '$roomId': {
        messages: {
          '$messageId': {
            '.write': "root.child('members').child($roomId).child(auth.uid).exists()",
            '.read': "root.child('members').child($roomId).child(auth.uid).exists()",
          },
        },
      },
    },
    members: {
      '.read': false,
      '.write': false,
    },
  },
};

const DENY_ALL_RTDB_RULES = {
  rules: {
    '.read': false,
    '.write': false,
  },
};

const originalFetch = global.fetch;

async function captureFirestoreFixture(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  db.setRules(ALICE_RULES);
  await db.doc('notes/welcome').set({ title: 'welcome', priority: 1 });
  await db.doc('notes/first').set({ title: 'first', priority: 2 });
  return buildVerifyFixture({
    sandbox,
    description: 'alice creates two notes',
    firestoreRules: ALICE_RULES,
  });
}

async function captureRtdbFixture(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const adminDb = getDatabase(sandbox);
  rtdbSandbox.setRules(adminDb, RTDB_MEMBER_RULES);
  rtdbSandbox.setData(adminDb, {
    '/members/r1/alice': true,
  });

  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  await set(ref(db, '/rooms/r1/messages/m1'), {
    author: 'alice',
    text: 'hello',
  });

  return buildVerifyFixture({
    sandbox,
    description: 'alice writes an RTDB room message',
    rtdbRules: RTDB_MEMBER_RULES,
    rtdbState: rtdbSandbox.snapshotState(adminDb),
  });
}

async function verifyIn(dir: string, argv: string[], deps?: VerifyCliDeps): Promise<number> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await runVerify(parseArgs(['verify', ...argv]), deps);
  } finally {
    process.chdir(prev);
  }
}

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'pyric-verify-'));
  dirs.push(d);
  return d;
}

function writeFirebaseJson(dir: string, config: Record<string, unknown>): void {
  writeFileSync(join(dir, 'firebase.json'), JSON.stringify(config, null, 2));
}

afterEach(() => {
  global.fetch = originalFetch;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('exit 0 when the captured Firestore session replays cleanly under firebase.json rules', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    expect(await verifyIn(dir, ['session.json'])).toBe(0);
  });

  it('exit 1 when Firestore candidate rules would change captured writes', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), DENY_ALL_FIRESTORE_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    expect(await verifyIn(dir, ['session.json'])).toBe(1);
  });

  it('no positional arg replays the latest serve capture', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    mkdirSync(join(dir, '.pyric'), { recursive: true });
    writeFileSync(join(dir, '.pyric', 'last-session.json'), JSON.stringify(await captureFirestoreFixture()));
    expect(await verifyIn(dir, [])).toBe(0);
  });

  it('exit 2 when there is no captured session and none was passed', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    expect(await verifyIn(dir, [])).toBe(2);
  });

  it('exit 2 when selected service rules cannot be resolved', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    expect(await verifyIn(dir, ['session.json'])).toBe(2);
  });

  it('honors service-qualified --rules overrides', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    writeFileSync(join(dir, 'prod.rules'), DENY_ALL_FIRESTORE_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    expect(await verifyIn(dir, ['session.json', '--rules', 'firestore=prod.rules'])).toBe(1);
  });

  it('rejects unqualified --rules values', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    expect(await verifyIn(dir, ['session.json', '--rules', 'prod.rules'])).toBe(2);
  });

  it('verifies RTDB fixtures against database.rules from firebase.json', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { database: { rules: 'database.rules.json' } });
    writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(RTDB_MEMBER_RULES));
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureRtdbFixture()));
    expect(await verifyIn(dir, ['session.json'])).toBe(0);
  });

  it('exit 1 when RTDB candidate rules now deny captured writes', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { database: { rules: 'database.rules.json' } });
    writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(DENY_ALL_RTDB_RULES));
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureRtdbFixture()));
    expect(await verifyIn(dir, ['session.json'])).toBe(1);
  });

  it('filters services with repeated --service and repeated --rules', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, {
      firestore: { rules: 'firestore.rules' },
      database: { rules: 'database.rules.json' },
    });
    writeFileSync(join(dir, 'firestore.rules'), DENY_ALL_FIRESTORE_RULES);
    writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(DENY_ALL_RTDB_RULES));
    writeFileSync(join(dir, 'rtdb-allow.json'), JSON.stringify(RTDB_MEMBER_RULES));
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureRtdbFixture()));
    expect(
      await verifyIn(dir, [
        'session.json',
        '--service',
        'database',
        '--rules',
        'firestore=firestore.rules',
        '--rules',
        'database=rtdb-allow.json',
      ]),
    ).toBe(0);
  });

  it('--json returns the right exit code', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), DENY_ALL_FIRESTORE_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    expect(await verifyIn(dir, ['session.json', '--json'])).toBe(1);
  });

  it('derives Rules Test API cases to an output file', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    const code = await verifyIn(dir, ['cases', 'session.json', '--service', 'firestore', '--out', 'session.cases.json']);
    expect(code).toBe(0);
    const out = JSON.parse(readFileSync(join(dir, 'session.cases.json'), 'utf8'));
    expect(out.service).toBe('firestore');
    expect(out.testCases.length).toBeGreaterThan(0);
  });

  it('runs the Rules Test API engine with a project scope resolver', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    (global as any).fetch = async () =>
      new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }, { state: 'SUCCESS' }] }), { status: 200 });

    const code = await verifyIn(
      dir,
      ['session.json', '--engine', 'rules-test-api', '--project', 'demo-project'],
      {
        resolveScope: async ({ projectId }) => ({
          scope: { projectId: projectId ?? 'demo-project', resolveToken: async () => 'mock-token' },
          source: 'adc',
          grantedScopes: 'all',
        }),
      },
    );

    expect(code).toBe(0);
  });

  it('runs both sandbox and Rules Test API engines', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { firestore: { rules: 'firestore.rules' } });
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFirestoreFixture()));
    (global as any).fetch = async () =>
      new Response(JSON.stringify({ testResults: [{ state: 'SUCCESS' }, { state: 'SUCCESS' }] }), { status: 200 });

    const code = await verifyIn(
      dir,
      ['session.json', '--engine', 'both', '--project', 'demo-project'],
      {
        resolveScope: async ({ projectId }) => ({
          scope: { projectId: projectId ?? 'demo-project', resolveToken: async () => 'mock-token' },
          source: 'adc',
          grantedScopes: 'all',
        }),
      },
    );

    expect(code).toBe(0);
  });

  it('rejects RTDB with the Rules Test API engine', async () => {
    const dir = tmp();
    writeFirebaseJson(dir, { database: { rules: 'database.rules.json' } });
    writeFileSync(join(dir, 'database.rules.json'), JSON.stringify(RTDB_MEMBER_RULES));
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureRtdbFixture()));

    const code = await verifyIn(
      dir,
      ['session.json', '--service', 'database', '--engine', 'rules-test-api', '--project', 'demo-project'],
      {
        resolveScope: async ({ projectId }) => ({
          scope: { projectId: projectId ?? 'demo-project', resolveToken: async () => 'mock-token' },
          source: 'adc',
          grantedScopes: 'all',
        }),
      },
    );

    expect(code).toBe(2);
  });
});
