import { describe, it, expect } from 'bun:test';
import {
  computeActivityDigest,
  type ActivityBandKey,
} from '../../../src/events/digest.js';
import {
  reqEvent,
  writeEvent,
  svcEvent,
  unmodelledEvent,
} from '../helpers/fake-events.js';

// A fixed clock so the relative `when` strings are deterministic.
const NOW = 1_700_000_100_000;

function bandKeys(events: Parameters<typeof computeActivityDigest>[0]): ActivityBandKey[] {
  return computeActivityDigest(events, { now: NOW }).bands.map((b) => b.key);
}

describe('computeActivityDigest — categorization', () => {
  it('returns an empty digest for no events', () => {
    const d = computeActivityDigest([], { now: NOW });
    expect(d.total).toBe(0);
    expect(d.bands).toEqual([]);
    expect(d.denials).toEqual([]);
    expect(d.deniedCount).toBe(0);
  });

  it('skips unmodelled event kinds (listener lifecycle, etc.)', () => {
    const d = computeActivityDigest(
      [unmodelledEvent(), writeEvent(), unmodelledEvent()],
      { now: NOW },
    );
    expect(d.total).toBe(1);
  });

  it('buckets a created doc into Added', () => {
    const d = computeActivityDigest(
      [writeEvent({ method: 'create', path: 'notes/n1' })],
      { now: NOW },
    );
    expect(d.bands[0].key).toBe('added');
    expect(d.bands[0].rows[0].target).toBe('notes/n1');
  });

  it('buckets an updated doc into Updated with a single-field change summary', () => {
    const d = computeActivityDigest(
      [
        writeEvent({
          method: 'update',
          priorState: { done: false, title: 'x' },
          nextState: { done: true, title: 'x' },
        }),
      ],
      { now: NOW },
    );
    expect(d.bands[0].key).toBe('updated');
    expect(d.bands[0].rows[0].change).toBe('done → true');
  });

  it('buckets a deleted doc into Removed', () => {
    const d = computeActivityDigest(
      [writeEvent({ method: 'delete', nextState: null })],
      { now: NOW },
    );
    expect(d.bands[0].key).toBe('removed');
    expect(d.bands[0].rows[0].change).toBe('deleted');
  });

  it('surfaces a create field preview as the change', () => {
    const d = computeActivityDigest(
      [writeEvent({ method: 'create', nextState: { title: 'Ship the redesign' } })],
      { now: NOW },
    );
    expect(d.bands[0].rows[0].change).toBe('"Ship the redesign"');
  });
});

describe('computeActivityDigest — denials are first-class', () => {
  it('buckets a denied request into the Denied band and the denials projection', () => {
    const d = computeActivityDigest(
      [
        reqEvent({
          method: 'update',
          path: 'notes/n1',
          result: 'deny',
          reasons: ['Rule #0 (update) → DENY'],
          auth: { uid: 'alice' },
        }),
      ],
      { now: NOW },
    );
    expect(d.deniedCount).toBe(1);
    expect(d.bands[0].key).toBe('denied');
    expect(d.bands[0].rows[0].denied).toBe(true);
    expect(d.bands[0].rows[0].change).toBe('update, update rule');
    expect(d.denials.length).toBe(1);
    expect(d.denials[0].id).toBe(d.bands[0].rows[0].id);
  });

  it('leads with Denied even when added/updated events outnumber it', () => {
    const events = [
      writeEvent({ method: 'create' }),
      writeEvent({ method: 'create' }),
      writeEvent({ method: 'update', priorState: { a: 1 }, nextState: { a: 2 } }),
      reqEvent({ result: 'deny', reasons: ['Rule #0 (create) → DENY'] }),
    ];
    expect(bandKeys(events)[0]).toBe('denied');
  });

  it('orders bands lead-with-consequence: denied, errored, added, updated, removed', () => {
    const events = [
      writeEvent({ method: 'delete', nextState: null }),
      writeEvent({ method: 'update', priorState: { a: 1 }, nextState: { a: 2 } }),
      writeEvent({ method: 'create' }),
      reqEvent({ result: 'unsupported' }),
      reqEvent({ result: 'deny', reasons: ['Rule #0 (get) → DENY'] }),
    ];
    expect(bandKeys(events)).toEqual([
      'denied',
      'errored',
      'added',
      'updated',
      'removed',
    ]);
  });
});

describe('computeActivityDigest — multi-service events', () => {
  it('maps auth sign-in / sign-out / user ops to their bands', () => {
    const d = computeActivityDigest(
      [
        svcEvent({ service: 'auth', op: 'sign_in', path: 'alice' }),
        svcEvent({ service: 'auth', op: 'sign_out', path: 'alice' }),
        svcEvent({ service: 'auth', op: 'user_create', path: 'bob' }),
        svcEvent({ service: 'auth', op: 'user_delete', path: 'carol' }),
      ],
      { now: NOW },
    );
    const keys = d.bands.map((b) => b.key).sort();
    expect(keys).toEqual(['added', 'removed', 'signed-in', 'signed-out']);
  });

  it('maps storage object_put (new vs overwrite) to Added vs Updated', () => {
    const dNew = computeActivityDigest(
      [svcEvent({ service: 'storage', op: 'object_put', path: 'avatars/a.png' })],
      { now: NOW },
    );
    expect(dNew.bands[0].key).toBe('added');
    expect(dNew.bands[0].rows[0].target).toBe('avatars/a.png');

    const dOver = computeActivityDigest(
      [
        svcEvent({
          service: 'storage',
          op: 'object_put',
          path: 'avatars/a.png',
          before: { size: 1 },
        }),
      ],
      { now: NOW },
    );
    expect(dOver.bands[0].key).toBe('updated');
  });

  it('maps rtdb set/remove to bands using before-state', () => {
    const d = computeActivityDigest(
      [
        svcEvent({ service: 'rtdb', op: 'set', path: '/rooms/r1', before: null }),
        svcEvent({ service: 'rtdb', op: 'remove', path: '/rooms/r2' }),
      ],
      { now: NOW },
    );
    const keys = d.bands.map((b) => b.key).sort();
    expect(keys).toEqual(['added', 'removed']);
  });

  it('routes an unknown service op to the Other band without dropping it', () => {
    const d = computeActivityDigest(
      [svcEvent({ service: 'storage', op: 'frobnicate', path: 'x' })],
      { now: NOW },
    );
    expect(d.bands[0].key).toBe('other');
    expect(d.bands[0].rows[0].change).toBe('frobnicate');
  });

  it('handles a mixed firestore + auth + storage + rtdb stream in one fold', () => {
    const d = computeActivityDigest(
      [
        writeEvent({ method: 'create', service: 'firestore' }),
        svcEvent({ service: 'auth', op: 'sign_in', path: 'alice' }),
        svcEvent({ service: 'storage', op: 'object_put', path: 'f.png' }),
        svcEvent({ service: 'rtdb', op: 'update', path: '/x' }),
        reqEvent({ result: 'deny', reasons: ['Rule #0 (update) → DENY'] }),
      ],
      { now: NOW },
    );
    expect(d.total).toBe(5);
    expect(d.bands[0].key).toBe('denied');
  });
});

describe('computeActivityDigest — actor / lens / subject attribution', () => {
  it('derives the lens label from authLens (app / as uid / admin)', () => {
    const d = computeActivityDigest(
      [
        writeEvent({ id: 'app', authLens: { mode: 'app-session' } }),
        writeEvent({ id: 'as', authLens: { mode: 'as', uid: 'alice' } }),
        writeEvent({ id: 'adm', authLens: { mode: 'admin' } }),
      ],
      { now: NOW },
    );
    const byId = new Map(d.bands[0].rows.map((r) => [r.id, r.lens]));
    expect(byId.get('app')).toBe('app');
    // The "AS" column carries just the uid (the column header supplies "as").
    expect(byId.get('as')).toBe('alice');
    expect(byId.get('adm')).toBe('admin');
  });

  it('carries the on-behalf-of subject into `for`', () => {
    const d = computeActivityDigest(
      [writeEvent({ auth: { uid: 'bob' } })],
      { now: NOW },
    );
    expect(d.bands[0].rows[0].for).toBe('bob');
    expect(d.bands[0].rows[0].subjectUid).toBe('bob');
  });

  it('attributes a band to a single subject ("all by alice")', () => {
    const d = computeActivityDigest(
      [
        reqEvent({ result: 'deny', auth: { uid: 'alice' }, reasons: ['Rule #0 (update) → DENY'] }),
        reqEvent({ result: 'deny', auth: { uid: 'alice' }, reasons: ['Rule #0 (update) → DENY'] }),
      ],
      { now: NOW },
    );
    expect(d.bands[0].attribution).toBe('all by alice');
  });

  it('attributes a band to a single actor ("by agent atlas") when subjects differ', () => {
    const d = computeActivityDigest(
      [
        writeEvent({ method: 'create', auth: { uid: 'alice' }, actor: { kind: 'agent', name: 'atlas' } }),
        writeEvent({ method: 'create', auth: { uid: 'bob' }, actor: { kind: 'agent', name: 'atlas' } }),
      ],
      { now: NOW },
    );
    expect(d.bands[0].attribution).toBe('by agent atlas');
  });

  it('omits attribution when both actor and subject are mixed', () => {
    const d = computeActivityDigest(
      [
        writeEvent({ method: 'create', auth: { uid: 'alice' }, actor: { kind: 'app' } }),
        writeEvent({ method: 'create', auth: { uid: 'bob' }, actor: { kind: 'agent', name: 'atlas' } }),
      ],
      { now: NOW },
    );
    expect(d.bands[0].attribution).toBeUndefined();
  });

  it('defaults missing provenance to app / app-session', () => {
    const d = computeActivityDigest([writeEvent({ actor: undefined, authLens: undefined })], {
      now: NOW,
    });
    const row = d.bands[0].rows[0];
    expect(row.actor).toEqual({ kind: 'app' });
    expect(row.authLens).toEqual({ mode: 'app-session' });
    expect(row.lens).toBe('app');
  });

  it('preserves planId on rows when present', () => {
    const d = computeActivityDigest(
      [writeEvent({ planId: 'plan-7' })],
      { now: NOW },
    );
    expect(d.bands[0].rows[0].planId).toBe('plan-7');
  });
});

describe('computeActivityDigest — ordering & grouping', () => {
  it('orders rows within a band newest-first by default (recency)', () => {
    const d = computeActivityDigest(
      [
        writeEvent({ id: 'old', method: 'create', at: 1000 }),
        writeEvent({ id: 'new', method: 'create', at: 2000 }),
      ],
      { now: NOW },
    );
    expect(d.bands[0].rows.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('orders chronologically when asked', () => {
    const d = computeActivityDigest(
      [
        writeEvent({ id: 'old', method: 'create', at: 1000 }),
        writeEvent({ id: 'new', method: 'create', at: 2000 }),
      ],
      { now: NOW, order: 'chronological' },
    );
    expect(d.bands[0].rows.map((r) => r.id)).toEqual(['old', 'new']);
  });

  it('pivots a band by actor when groupBy: actor', () => {
    const d = computeActivityDigest(
      [
        writeEvent({ id: 'a1', method: 'create', actor: { kind: 'app' } }),
        writeEvent({ id: 'g1', method: 'create', actor: { kind: 'agent', name: 'atlas' } }),
        writeEvent({ id: 'a2', method: 'create', actor: { kind: 'app' } }),
      ],
      { now: NOW, groupBy: 'actor' },
    );
    const band = d.bands[0];
    expect(band.subgroups).toBeDefined();
    const keys = band.subgroups!.map((g) => g.key).sort();
    expect(keys).toEqual(['agent:atlas', 'app']);
    // Largest subgroup first.
    expect(band.subgroups![0].key).toBe('app');
    expect(band.subgroups![0].count).toBe(2);
    // Each row stamped with its group key.
    expect(band.rows.find((r) => r.id === 'g1')!.groupKey).toBe('agent:atlas');
  });

  it('pivots by subject and by lens', () => {
    const bySubject = computeActivityDigest(
      [
        writeEvent({ method: 'create', auth: { uid: 'alice' } }),
        writeEvent({ method: 'create', auth: { uid: 'bob' } }),
      ],
      { now: NOW, groupBy: 'subject' },
    );
    expect(bySubject.bands[0].subgroups!.map((g) => g.key).sort()).toEqual([
      'alice',
      'bob',
    ]);

    const byLens = computeActivityDigest(
      [
        writeEvent({ method: 'create', authLens: { mode: 'admin' } }),
        writeEvent({ method: 'create', authLens: { mode: 'as', uid: 'alice' } }),
      ],
      { now: NOW, groupBy: 'lens' },
    );
    expect(byLens.bands[0].subgroups!.map((g) => g.key).sort()).toEqual([
      'admin',
      'as:alice',
    ]);
  });

  it('leaves bands flat (no subgroups) when groupBy is none', () => {
    const d = computeActivityDigest([writeEvent({ method: 'create' })], {
      now: NOW,
    });
    expect(d.bands[0].subgroups).toBeUndefined();
  });

  it('keeps band.count as the true total even when rowsPerBand trims rows', () => {
    const events = Array.from({ length: 5 }, (_, i) =>
      writeEvent({ id: `c${i}`, method: 'create' }),
    );
    const d = computeActivityDigest(events, { now: NOW, rowsPerBand: 2 });
    expect(d.bands[0].count).toBe(5);
    expect(d.bands[0].rows.length).toBe(2);
  });
});

describe('computeActivityDigest — when column', () => {
  it('renders a session-relative when string', () => {
    const d = computeActivityDigest(
      [writeEvent({ method: 'create', at: NOW - 60_000 })],
      { now: NOW },
    );
    expect(d.bands[0].rows[0].when).toBe('1m');
  });
});
