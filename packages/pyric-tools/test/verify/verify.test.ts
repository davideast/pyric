import { describe, expect, it } from 'bun:test';
import {
  getDatabase,
  ref,
  remove,
  runTransaction,
  set,
  update,
  sandbox as rtdbSandbox,
} from 'pyric/database';
import { defineRtdbRules, allow, deny } from 'pyric/rules/rtdb';
import { initializeSandbox } from 'pyric/sandbox';
import {
  buildVerifyFixture,
  parseVerifyFixture,
  verifyFixture,
  type PyricVerifyFixture,
} from '../../src/verify/index.js';

const ALLOW_ALL_RTDB = { rules: { '.read': true, '.write': true } };
const DENY_ALL_RTDB = { rules: { '.read': false, '.write': false } };

async function captureRtdbJourney(): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const adminDb = getDatabase(sandbox);
  rtdbSandbox.setRules(adminDb, ALLOW_ALL_RTDB);
  rtdbSandbox.setData(adminDb, {
    '/counters/c1': 1,
    '/gone/x': true,
  });

  const db = getDatabase(sandbox.withAuth({ uid: 'alice' }));
  await set(ref(db, '/profiles/alice'), { name: 'Alice' });
  await update(ref(db, '/profiles/alice'), { active: true });
  await remove(ref(db, '/gone/x'));
  await runTransaction<number>(ref(db, '/counters/c1'), (current) => (current ?? 0) + 1, {
    applyLocally: false,
  });

  return buildVerifyFixture({
    sandbox,
    rtdbRules: ALLOW_ALL_RTDB,
    rtdbState: rtdbSandbox.snapshotState(adminDb),
  });
}

describe('verifyFixture', () => {
  it('parses service-shaped fixtures and rejects the old flat shape', () => {
    const good = buildVerifyFixture({
      sandbox: initializeSandbox(),
      rtdbRules: ALLOW_ALL_RTDB,
      rtdbState: {},
    });
    expect(parseVerifyFixture(good).schema).toBe('pyric.verify.fixture.v1');
    expect(() => parseVerifyFixture({ rules: '', events: [], state: {} })).toThrow(
      /fixture schema/,
    );
  });

  it('accepts an RtdbRulesDocument and replays set, update, remove, and transaction commits', async () => {
    const fixture = await captureRtdbJourney();
    const rules = defineRtdbRules({
      paths: {
        '/': { read: allow(), write: allow() },
      },
    });

    const result = await verifyFixture(fixture, {
      rules: { rtdb: rules },
    });

    expect(result.ok).toBe(true);
    expect(result.services.rtdb?.checkedEvents).toBe(4);
  });

  it('reports now-denied when RTDB candidate rules reject captured writes', async () => {
    const fixture = await captureRtdbJourney();
    const result = await verifyFixture(fixture, {
      rules: { rtdb: DENY_ALL_RTDB },
    });

    expect(result.ok).toBe(false);
    expect(result.services.rtdb?.divergences.some((d) => d.kind === 'now-denied')).toBe(true);
  });

  it('reports state drift when replayed RTDB state differs from the fixture', async () => {
    const fixture = await captureRtdbJourney();
    const tampered = JSON.parse(JSON.stringify(fixture)) as PyricVerifyFixture;
    const tree = tampered.services.rtdb!.state.tree as {
      profiles: { alice: { name: string; active: boolean } };
    };
    tree.profiles.alice.name = 'Mallory';
    const result = await verifyFixture(tampered, {
      rules: { rtdb: ALLOW_ALL_RTDB },
    });

    expect(result.ok).toBe(false);
    expect(result.services.rtdb?.divergences.some((d) => d.kind === 'state-drift')).toBe(true);
  });

  it('compiles denying constraints documents through toJSON', async () => {
    const fixture = await captureRtdbJourney();
    const rules = defineRtdbRules({
      paths: {
        '/': { read: deny(), write: deny() },
      },
    });

    const result = await verifyFixture(fixture, {
      rules: { rtdb: rules },
    });

    expect(result.ok).toBe(false);
    expect(result.services.rtdb?.divergences.some((d) => d.kind === 'now-denied')).toBe(true);
  });
});
