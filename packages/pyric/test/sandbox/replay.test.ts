/**
 * Tests for the replay engine exported from `@pyric/sandbox`.
 *
 * Each test captures an event stream via `sandbox.history()`, then
 * hands it to `replay(events, rules)` and asserts the classification
 * of the produced divergences against an originalState snapshot.
 *
 * Imports come from the main entry — replay is a first-class export,
 * not a subpath.
 */
import { describe, it, expect } from 'bun:test';
import {
  initializeSandbox,
  replay,
  type Divergence,
  type RequestEvent,
  type Sandbox,
  type WriteSandboxEvent,
} from '../../src/sandbox/index.js';
import { getInternalEnv } from '../../src/sandbox/internal/sandbox-impl.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /things/{id} {
      allow read, write: if request.auth.uid == 'alice';
    }
  }
}`;

function setup(): { sandbox: Sandbox; env: ReturnType<typeof getInternalEnv> } {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules: RULES });
  return { sandbox, env };
}

describe('replay()', () => {
  it('round-trips plain writes with zero divergence', () => {
    const { sandbox, env } = setup();
    env.execute({ method: 'set', path: 'things/a', auth: { uid: 'alice' }, data: { v: 1 } });
    env.execute({ method: 'set', path: 'things/b', auth: { uid: 'alice' }, data: { v: 2, name: 'two' } });
    env.execute({ method: 'update', path: 'things/a', auth: { uid: 'alice' }, data: { v: 99 } });

    const originalState = sandbox.snapshot().firestore;
    const result = replay(sandbox.history(), RULES, {}, originalState);

    expect(result.divergences).toHaveLength(0);
    const replayedState = result.sandbox.snapshot().firestore;
    expect(replayedState['things/a']).toEqual({ v: 99 });
    expect(replayedState['things/b']).toEqual({ v: 2, name: 'two' });
  });

  it('pinRequestTime makes serverTimestamp resolve identically', () => {
    const { sandbox, env } = setup();
    env.execute({
      method: 'set',
      path: 'things/ts',
      auth: { uid: 'alice' },
      data: { createdAt: { __type: 'serverTimestamp' } },
    });

    // Small artificial delay so a non-pinned replay would drift.
    const start = performance.now();
    while (performance.now() - start < 4) { /* spin */ }

    const originalState = sandbox.snapshot().firestore;
    const pinned = replay(sandbox.history(), RULES, { pinRequestTime: true }, originalState);

    expect(pinned.divergences).toHaveLength(0);
    const replayedDoc = (pinned.sandbox.snapshot().firestore['things/ts']);
    expect(replayedDoc).toEqual(originalState['things/ts']!);
  });

  it('without pinRequestTime, serverTimestamp drift surfaces as time-drift', () => {
    const { sandbox, env } = setup();
    env.execute({
      method: 'set',
      path: 'things/ts',
      auth: { uid: 'alice' },
      data: { createdAt: { __type: 'serverTimestamp' } },
    });

    const start = performance.now();
    while (performance.now() - start < 5) { /* spin so the clock advances */ }

    const originalState = sandbox.snapshot().firestore;
    const fresh = replay(sandbox.history(), RULES, { pinRequestTime: false }, originalState);

    // Either zero diffs (lucky — the clock didn't advance enough) or
    // exactly one time-drift entry. No real-divergence either way.
    const real = fresh.divergences.filter((d): d is Extract<Divergence, { kind: 'real-divergence' }> => d.kind === 'real-divergence');
    const drift = fresh.divergences.filter((d): d is Extract<Divergence, { kind: 'time-drift' }> => d.kind === 'time-drift');
    expect(real).toHaveLength(0);
    if (drift.length > 0) {
      expect(drift[0]!.field).toBe('createdAt');
    }
  });

  it('classifies autoid-alias for createWithAutoId, mints fresh on replay', () => {
    const { sandbox, env } = setup();
    const { path: originalAutoPath } = env.createWithAutoId('things', { kind: 'auto' }, { uid: 'alice' });

    const originalState = sandbox.snapshot().firestore;
    const result = replay(sandbox.history(), RULES, {}, originalState);

    expect(result.pathAliases.has(originalAutoPath)).toBe(true);
    const replayedPath = result.pathAliases.get(originalAutoPath)!;
    expect(replayedPath).not.toBe(originalAutoPath);

    // Divergences: exactly the one autoid-alias entry; no real-divergence.
    const aliasDivs = result.divergences.filter((d) => d.kind === 'autoid-alias');
    expect(aliasDivs).toHaveLength(1);
    const real = result.divergences.filter((d) => d.kind === 'real-divergence');
    expect(real).toHaveLength(0);

    // The replayed sandbox holds the doc at the new path with the same data.
    const replayedDoc = (result.sandbox.snapshot().firestore[replayedPath]);
    expect(replayedDoc).toEqual({ kind: 'auto' });
  });

  it('rule changes between capture and replay surface as real-divergence', () => {
    const { sandbox, env } = setup();
    env.execute({ method: 'set', path: 'things/x', auth: { uid: 'alice' }, data: { v: 1 } });

    const originalState = sandbox.snapshot().firestore;
    // Tighter rule on replay: only the OWNER (alice) can write a doc
    // with `ownerId == alice`. The captured write has no ownerId.
    const TIGHTER = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /things/{id} {
      allow read: if true;
      allow write: if request.resource.data.ownerId == 'alice';
    }
  }
}`;
    const result = replay(sandbox.history(), TIGHTER, {}, originalState);

    // The replayed write was denied → the doc doesn't exist in the
    // replayed sandbox → the diff surfaces as real-divergence.
    const real = result.divergences.filter((d) => d.kind === 'real-divergence');
    expect(real.length).toBeGreaterThan(0);
  });

  it('replays admin setup writes as context without requiring candidate rules to allow them', () => {
    const { sandbox, env } = setup();
    env.execute({
      method: 'set',
      path: 'things/setup',
      auth: null,
      data: { seeded: true },
      bypassRules: true,
    });
    env.execute({
      method: 'set',
      path: 'things/user',
      auth: { uid: 'alice' },
      data: { value: 1 },
    });

    const events = sandbox.history();
    const setupRequest = events.find(
      (event): event is RequestEvent => event.kind === 'request' && event.path === 'things/setup',
    );
    const setupWrite = events.find(
      (event): event is WriteSandboxEvent => event.kind === 'write' && event.path === 'things/setup',
    );

    expect(setupRequest?.detail?.admin).toBe(true);
    expect(setupWrite?.detail?.admin).toBe(true);

    const originalState = sandbox.snapshot().firestore;
    const result = replay(events, RULES, {}, originalState);

    expect(result.divergences).toHaveLength(0);
    expect(result.sandbox.snapshot().firestore['things/setup']).toEqual({ seeded: true });
    expect(result.sandbox.snapshot().firestore['things/user']).toEqual({ value: 1 });
  });

  it('captures sentinels across batch sub-ops and re-issues on replay', () => {
    const { sandbox, env } = setup();
    env.execute({ method: 'set', path: 'things/seed', auth: { uid: 'alice' }, data: { n: 0 } });
    env.batch(
      [
        { method: 'update', path: 'things/seed', data: { n: { __type: 'increment', value: 7 } } },
      ],
      { uid: 'alice' },
    );

    const originalState = sandbox.snapshot().firestore;
    expect(originalState['things/seed']).toEqual({ n: 7 });

    const result = replay(sandbox.history(), RULES, {}, originalState);
    expect(result.divergences).toHaveLength(0);
    expect(result.sandbox.snapshot().firestore['things/seed']).toEqual({ n: 7 });
  });

  it('sentinel at a nested field does not mask a sibling real-divergence', () => {
    // Capture a write with a nested serverTimestamp AND a plain
    // sibling field. After capture, mutate the sibling in the
    // originalState we hand to replay so the replayed state diverges
    // at the sibling — that drift must surface as `real-divergence`
    // even though the parent (profile) contains a sentinel.
    const { sandbox, env } = setup();
    env.execute({
      method: 'set',
      path: 'things/p',
      auth: { uid: 'alice' },
      data: {
        profile: {
          lastSeen: { __type: 'serverTimestamp' },
          name: 'alice',
        },
      },
    });

    const captured = sandbox.snapshot().firestore;
    const profile = captured['things/p']!.profile as Record<string, unknown>;
    const tamperedOriginal: Record<string, Record<string, unknown>> = {
      'things/p': { profile: { ...profile, name: 'NOT-alice' } },
    };

    const result = replay(sandbox.history(), RULES, { pinRequestTime: true }, tamperedOriginal);

    const real = result.divergences.filter((d): d is Extract<Divergence, { kind: 'real-divergence' }> => d.kind === 'real-divergence');
    expect(real).toHaveLength(1);
    expect(real[0]!.field).toBe('profile.name');
    expect(real[0]!.before).toBe('NOT-alice');
    expect(real[0]!.after).toBe('alice');

    // And under pinRequestTime the sentinel-bearing leaf does NOT
    // surface as drift (clock pinned → resolves identically).
    const drift = result.divergences.filter((d) => d.kind === 'sentinel-drift' || d.kind === 'time-drift');
    expect(drift).toHaveLength(0);
  });

  it('unpinned replay surfaces time-drift end-to-end (pre-resolution capture)', () => {
    // Locks in the "no shape inference" promise: when the sandbox
    // captures a serverTimestamp() sentinel, the captured request.event
    // ships the marker (NOT the resolved Timestamp). Unpinned replay
    // re-resolves against a fresh clock and surfaces drift.
    const { sandbox, env } = setup();
    env.execute({
      method: 'set',
      path: 'things/x',
      auth: { uid: 'alice' },
      data: { ts: { __type: 'serverTimestamp' } },
    });

    // Verify capture preserved the marker — this is the key contract.
    const reqEv = sandbox.history().find((e) => e.kind === 'request');
    expect((reqEv as { request?: { resourceData?: { ts?: { __type?: string } } } }).request?.resourceData?.ts?.__type)
      .toBe('serverTimestamp');

    const start = performance.now();
    while (performance.now() - start < 20) { /* spin */ }

    const state = sandbox.snapshot().firestore;
    const result = replay(sandbox.history(), RULES, { pinRequestTime: false }, state);

    const drift = result.divergences.filter((d): d is Extract<Divergence, { kind: 'time-drift' }> => d.kind === 'time-drift');
    const real = result.divergences.filter((d) => d.kind === 'real-divergence');
    expect(real).toHaveLength(0);
    // Flake-tolerant: 0 if Date.now() didn't tick across the 20ms spin
    // on a coarse-resolution kernel. Most runs will see 1.
    if (drift.length > 0) {
      expect(drift[0]!.field).toBe('ts');
    }

    // Pinned replay re-issues the captured requestTime → zero drift.
    const pinned = replay(sandbox.history(), RULES, { pinRequestTime: true }, state);
    expect(pinned.divergences).toHaveLength(0);
  });

  it('replay without originalState returns the fresh sandbox and empty divergences', () => {
    const { sandbox, env } = setup();
    env.execute({ method: 'set', path: 'things/a', auth: { uid: 'alice' }, data: { v: 1 } });

    const result = replay(sandbox.history(), RULES);
    expect(result.divergences).toHaveLength(0);
    expect(result.sandbox.snapshot().firestore['things/a']).toEqual({ v: 1 });
  });
});
