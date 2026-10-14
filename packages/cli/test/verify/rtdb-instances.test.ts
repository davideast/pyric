import { describe, expect, it } from 'bun:test';
import { getDatabase, ref, set, sandbox as rtdbSandbox } from 'pyric/database';
import { initializeSandbox } from 'pyric/sandbox';

import {
  buildVerifyFixture,
  capturedDefaultRtdbInstance,
  parseVerifyFixture,
  recordedRtdbInstances,
  recordsDefaultRtdbInstance,
  verifyFixture,
  type PyricVerifyFixture,
} from '../../src/verify/index.js';
import { captureRtdbInstances, defaultInstanceUrl } from '../../src/verify/rtdb-instance-capture.js';

const OPEN = { rules: { '.read': true, '.write': true } };
const SIGNED_IN = { rules: { '.read': 'auth != null', '.write': 'auth != null' } };
const READ_ONLY = { rules: { '.read': 'auth != null', '.write': false } };
const SHARD = 'https://shard-00.firebaseio.com';

/** A session that writes a lobby to the default instance and to shard-00, captured as the hosts capture it. */
async function captureTwoInstances(options: { defaultTouched?: boolean } = {}): Promise<PyricVerifyFixture> {
  const sandbox = initializeSandbox();
  const main = getDatabase(sandbox);
  const shard = getDatabase(sandbox, SHARD);
  rtdbSandbox.setRules(main, SIGNED_IN);
  rtdbSandbox.setRules(shard, SIGNED_IN);
  const alice = sandbox.withAuth({ uid: 'alice' });
  if (options.defaultTouched !== false) {
    await set(ref(getDatabase(alice), 'rooms/lobby'), { name: 'default lobby' });
  }
  await set(ref(getDatabase(alice, SHARD), 'rooms/lobby'), { name: 'shard lobby' });
  return buildVerifyFixture({
    sandbox,
    rtdbRules: SIGNED_IN,
    rtdbState: rtdbSandbox.snapshotState(main),
    rtdbDatabaseUrl: defaultInstanceUrl('demo-app-default-rtdb'),
    rtdbInstances: captureRtdbInstances(sandbox, 'demo-app-default-rtdb'),
  });
}

describe('the verify capture records every RTDB instance', () => {
  it('records each named instance with its active rules and tree, and the default instance URL', async () => {
    const fixture = parseVerifyFixture(JSON.parse(JSON.stringify(await captureTwoInstances())));
    const rtdb = fixture.services.rtdb;
    expect(rtdb?.state.tree).toEqual({ rooms: { lobby: { name: 'default lobby' } } });
    expect(rtdb?.databaseUrl).toBe('https://demo-app-default-rtdb.firebaseio.com');
    expect(Object.keys(rtdb?.instances ?? {})).toEqual(['shard-00']);
    expect(rtdb?.instances?.['shard-00']).toEqual({
      rules: { format: 'rtdb.rules.json', json: SIGNED_IN },
      state: { tree: { rooms: { lobby: { name: 'shard lobby' } } } },
    });
    expect(capturedDefaultRtdbInstance(fixture)).toBe('demo-app-default-rtdb');
  });

  it('leaves out a backend held under the default instance name', () => {
    const sandbox = initializeSandbox();
    getDatabase(sandbox, 'https://demo-app-default-rtdb.firebaseio.com');
    getDatabase(sandbox, SHARD);
    expect(Object.keys(captureRtdbInstances(sandbox, 'demo-app-default-rtdb'))).toEqual(['shard-00']);
  });

  it('records no URL while no project names the default instance', () => {
    expect(defaultInstanceUrl(undefined)).toBeUndefined();
    expect(defaultInstanceUrl('(default)')).toBeUndefined();
  });

  it('refuses a malformed instance capture', async () => {
    const fixture = JSON.parse(JSON.stringify(await captureTwoInstances())) as PyricVerifyFixture;
    (fixture.services.rtdb!.instances!['shard-00'] as { state: unknown }).state = {};
    expect(() => parseVerifyFixture(fixture)).toThrow('fixture.services.rtdb.instances["shard-00"].state.tree is required.');
  });

  it('names the instances a session used, from its events and its capture', async () => {
    const fixture = await captureTwoInstances();
    expect(recordedRtdbInstances(fixture)).toEqual(['shard-00']);
    expect(recordsDefaultRtdbInstance(fixture)).toBe(true);
    const shardOnly = await captureTwoInstances({ defaultTouched: false });
    expect(recordsDefaultRtdbInstance(shardOnly)).toBe(false);
  });
});

describe('verifyFixture checks each RTDB instance against its own rules', () => {
  it('reports now-denied on the instance whose candidate rules tightened, tagged with it', async () => {
    const result = await verifyFixture(await captureTwoInstances(), {
      rules: { rtdb: SIGNED_IN, rtdbInstances: { 'shard-00': READ_ONLY } },
    });
    const rtdb = result.services.rtdb;
    expect(result.ok).toBe(false);
    expect(rtdb?.checkedEvents).toBe(2);
    // The denied write never lands, so the shard's tree drifts too; the
    // default instance, under unchanged rules, reports nothing.
    expect(rtdb?.divergences.map(({ kind, instance, path }) => ({ kind, instance, path }))).toEqual([
      { kind: 'now-denied', instance: 'shard-00', path: '/rooms/lobby' },
      { kind: 'state-drift', instance: 'shard-00', path: '/rooms' },
    ]);
  });

  it('replays each instance into its own captured tree, so the same rules give no drift', async () => {
    const result = await verifyFixture(await captureTwoInstances(), {
      rules: { rtdb: SIGNED_IN, rtdbInstances: { 'shard-00': SIGNED_IN } },
    });
    expect(result.ok).toBe(true);
    expect(result.services.rtdb?.divergences).toEqual([]);
    expect(result.services.rtdb?.skippedInstances).toBeUndefined();
  });

  it('reports drift in a named instance\'s tree, tagged with the instance', async () => {
    const fixture = JSON.parse(JSON.stringify(await captureTwoInstances())) as PyricVerifyFixture;
    fixture.services.rtdb!.instances!['shard-00']!.state.tree = { rooms: { lobby: { name: 'tampered' } } };
    const result = await verifyFixture(fixture, {
      rules: { rtdb: OPEN, rtdbInstances: { 'shard-00': OPEN } },
    });
    const drift = result.services.rtdb?.divergences.filter((divergence) => divergence.kind === 'state-drift') ?? [];
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.every((divergence) => divergence.instance === 'shard-00')).toBe(true);
  });

  it('names a recorded instance it has no candidate rules for instead of checking it', async () => {
    const result = await verifyFixture(await captureTwoInstances(), { rules: { rtdb: SIGNED_IN } });
    expect(result.services.rtdb?.skippedInstances).toEqual(['shard-00']);
    expect(result.services.rtdb?.checkedEvents).toBe(1);
  });

  it('checks a session that used only a named instance without default rules', async () => {
    const result = await verifyFixture(await captureTwoInstances({ defaultTouched: false }), {
      rules: { rtdbInstances: { 'shard-00': READ_ONLY } },
    });
    expect(result.services.rtdb?.divergences.map(({ kind, instance }) => ({ kind, instance }))).toEqual([
      { kind: 'now-denied', instance: 'shard-00' },
      { kind: 'state-drift', instance: 'shard-00' },
    ]);
  });
});
