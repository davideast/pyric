/**
 * `pyric verify` CLI wrapper (runVerify). The pure replay helpers
 * (runFixture/checkDirectory/formatResults) mirror — and are covered by —
 * examples/replay/ci/check-fixtures.test.ts; this file pins the CLI-specific
 * behavior: exit codes, rules-file resolution, the default serve-capture
 * path, and the --json contract.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/sandbox/admin-firestore';
import { runVerify, type Fixture } from '../../src/cli/verify.js';
import { parseArgs } from '../../src/cli/parse-args.js';

const ALICE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if request.auth.uid == 'alice'; }
  }
}`;

const DENY_ALL_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} { allow read, write: if false; }
  }
}`;

async function captureFixture(): Promise<Fixture> {
  const sandbox = initializeSandbox();
  const db = getFirestore(sandbox.withAuth({ uid: 'alice' }));
  db.setRules(ALICE_RULES);
  await db.doc('notes/welcome').set({ title: 'welcome', priority: 1 });
  await db.doc('notes/first').set({ title: 'first', priority: 2 });
  return {
    description: 'alice creates two notes',
    rules: ALICE_RULES,
    events: sandbox.history(),
    state: sandbox.snapshot().firestore,
  };
}

/** Run `pyric verify <argv>` inside `dir` (runVerify reads process.cwd()). */
async function verifyIn(dir: string, argv: string[]): Promise<number> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await runVerify(parseArgs(['verify', ...argv]));
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
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('runVerify', () => {
  it('exit 0 when the captured session replays cleanly under the rules', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFixture()));
    expect(await verifyIn(dir, ['session.json'])).toBe(0);
  });

  it('exit 1 when the rules would deny captured writes (real divergence)', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'firestore.rules'), DENY_ALL_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFixture()));
    expect(await verifyIn(dir, ['session.json'])).toBe(1);
  });

  it('no positional arg → replays the latest serve capture (.pyric/last-session.json)', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    mkdirSync(join(dir, '.pyric'), { recursive: true });
    writeFileSync(join(dir, '.pyric', 'last-session.json'), JSON.stringify(await captureFixture()));
    expect(await verifyIn(dir, [])).toBe(0);
  });

  it('exit 2 when there is no captured session and none was passed', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    expect(await verifyIn(dir, [])).toBe(2);
  });

  it('exit 2 when the rules file is missing', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFixture()));
    expect(await verifyIn(dir, ['session.json'])).toBe(2);
  });

  it('honors --rules pointing at an alternate ruleset', async () => {
    const dir = tmp();
    // firestore.rules is permissive, but we verify against a deny-all file.
    writeFileSync(join(dir, 'firestore.rules'), ALICE_RULES);
    writeFileSync(join(dir, 'prod.rules'), DENY_ALL_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFixture()));
    expect(await verifyIn(dir, ['session.json', '--rules', 'prod.rules'])).toBe(1);
  });

  it('--json still returns the right exit code', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'firestore.rules'), DENY_ALL_RULES);
    writeFileSync(join(dir, 'session.json'), JSON.stringify(await captureFixture()));
    expect(await verifyIn(dir, ['session.json', '--json'])).toBe(1);
  });
});
