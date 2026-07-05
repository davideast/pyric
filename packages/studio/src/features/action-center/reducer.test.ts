/**
 * Tests for the Action Center reducer (Wave 2, F1).
 *
 * The reducer is pure, so these are plain `bun test` unit tests: no DOM, no
 * React. They cover: burst collapse + counts, multi-service folding, actor
 * attribution + auth-lens, identity/sample capture + bounding, newest-first
 * ordering, skip-rules (reads/denials/listeners ignored), and the phrasing.
 */

import { describe, expect, test } from 'bun:test';
import type { SandboxEvent } from 'pyric/sandbox';
import {
  attribution,
  digestFromEvents,
  emptyDigestState,
  foldDigest,
  phraseDigest,
  toMutation,
  SAMPLE_CAP,
} from './reducer.js';

// ─── Event builders (typed partials → SandboxEvent) ─────────────────────────

let _id = 0;
const nextId = () => `e${++_id}`;

function write(
  path: string,
  method: 'create' | 'update' | 'set' | 'delete',
  extra: Partial<SandboxEvent> = {},
): SandboxEvent {
  return {
    kind: 'write',
    id: nextId(),
    at: Date.now(),
    method,
    path,
    auth: null,
    priorState: null,
    nextState: method === 'delete' ? null : {},
    requestTime: { seconds: 0, nanoseconds: 0 },
    ...extra,
  } as SandboxEvent;
}

function serviceMutation(
  service: 'auth' | 'storage' | 'rtdb',
  op: string,
  extra: Partial<SandboxEvent> = {},
): SandboxEvent {
  return {
    kind: 'service_mutation',
    id: nextId(),
    at: Date.now(),
    service,
    op,
    auth: null,
    ...extra,
  } as SandboxEvent;
}

// ─── Burst collapse ─────────────────────────────────────────────────────────

describe('burst collapse', () => {
  test('10 doc creates to one collection collapse into a single item with count 10', () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      write(`users/u${i}`, 'create', { at: 1000 + i }),
    );
    const digest = digestFromEvents(events);
    expect(digest).toHaveLength(1);
    expect(digest[0]).toMatchObject({
      service: 'firestore',
      verb: 'added',
      bucket: 'users',
      count: 10,
      firstAt: 1000,
      lastAt: 1009,
    });
    expect(digest[0].distinctTargets).toBe(10);
    expect(phraseDigest(digest[0])).toBe('10 docs added to /users');
  });

  test('different ops on the same collection are separate items', () => {
    const digest = digestFromEvents([
      write('users/a', 'create'),
      write('users/b', 'update'),
      write('users/c', 'delete'),
    ]);
    expect(digest).toHaveLength(3);
    const verbs = digest.map((d) => d.verb).sort();
    expect(verbs).toEqual(['added', 'removed', 'updated']);
  });

  test('nested doc paths bucket on the parent collection', () => {
    const digest = digestFromEvents([
      write('users/alice/posts/p1', 'create'),
      write('users/alice/posts/p2', 'create'),
    ]);
    expect(digest).toHaveLength(1);
    expect(digest[0].bucket).toBe('users/alice/posts');
    expect(digest[0].count).toBe(2);
  });
});

// ─── Multi-service ──────────────────────────────────────────────────────────

describe('multi-service folding', () => {
  test('firestore + auth + storage + rtdb each get their own item(s)', () => {
    const digest = digestFromEvents([
      write('posts/p1', 'create'),
      serviceMutation('auth', 'user_create', { path: 'alice', at: 10 }),
      serviceMutation('storage', 'object_put', {
        path: 'avatars/alice.png',
        at: 20,
      }),
      serviceMutation('rtdb', 'set', { path: '/rooms/r1/typing', at: 30 }),
    ]);
    const services = digest.map((d) => d.service).sort();
    expect(services).toEqual(['auth', 'firestore', 'rtdb', 'storage']);
  });

  test('auth sign-ins collapse and attribute the identity', () => {
    const digest = digestFromEvents([
      serviceMutation('auth', 'sign_in', { path: 'alice', at: 1 }),
    ]);
    expect(digest[0].verb).toBe('signed in');
    expect(digest[0].identities).toContain('alice');
    expect(phraseDigest(digest[0])).toBe('alice signed in');
  });

  test('new user create phrases as "new user X created"', () => {
    const digest = digestFromEvents([
      serviceMutation('auth', 'user_create', { path: 'bob' }),
    ]);
    expect(phraseDigest(digest[0])).toBe('new user bob created');
  });

  test('storage uploads bucket on the folder and phrase with count', () => {
    const digest = digestFromEvents([
      serviceMutation('storage', 'object_put', { path: 'avatars/a.png' }),
      serviceMutation('storage', 'object_put', { path: 'avatars/b.png' }),
      serviceMutation('storage', 'object_put', { path: 'avatars/c.png' }),
    ]);
    expect(digest[0].bucket).toBe('avatars/');
    expect(digest[0].count).toBe(3);
    expect(phraseDigest(digest[0])).toBe('3 objects uploaded to avatars/');
  });

  test('users_clear phrases as "all users cleared"', () => {
    const digest = digestFromEvents([
      serviceMutation('auth', 'users_clear', { path: '*' }),
    ]);
    expect(phraseDigest(digest[0])).toBe('all users cleared');
  });
});

// ─── Actor attribution + auth-lens ──────────────────────────────────────────

describe('actor attribution', () => {
  test('absent actor defaults to app (no attribution suffix)', () => {
    const digest = digestFromEvents([write('users/a', 'create')]);
    expect(digest[0].actor).toEqual({ kind: 'app' });
    expect(attribution(digest[0])).toBe('');
  });

  test('the same op by different actors splits into separate items', () => {
    const digest = digestFromEvents([
      write('users/a', 'create', { actor: { kind: 'app' } }),
      write('users/b', 'create', { actor: { kind: 'agent', name: 'seed' } }),
    ]);
    expect(digest).toHaveLength(2);
    const agentItem = digest.find(
      (d) => d.actor.kind === 'agent',
    );
    expect(agentItem).toBeDefined();
    expect(attribution(agentItem!)).toBe('agent:seed');
  });

  test('admin lens surfaces in attribution', () => {
    const digest = digestFromEvents([
      write('users/a', 'create', {
        actor: { kind: 'studio' },
        authLens: { mode: 'admin' },
      }),
    ]);
    expect(digest[0].viaAdmin).toBe(true);
    expect(attribution(digest[0])).toBe('Studio · admin');
  });

  test('impersonation lens surfaces "as <uid>"', () => {
    const digest = digestFromEvents([
      write('users/a', 'update', {
        actor: { kind: 'studio' },
        authLens: { mode: 'as', uid: 'alice' },
      }),
    ]);
    expect(digest[0].impersonating).toBe('alice');
    expect(attribution(digest[0])).toBe('Studio · as alice');
  });

  test('app-builder actor attributes correctly', () => {
    const digest = digestFromEvents([
      write('config/x', 'set', { actor: { kind: 'app-builder' } }),
    ]);
    expect(attribution(digest[0])).toBe('App Builder');
  });
});

// ─── Identity + sample capture/bounding ─────────────────────────────────────

describe('identity + sample capture', () => {
  test('samples are bounded to SAMPLE_CAP, newest first, but distinct count is full', () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      write(`logs/l${i}`, 'create', { at: i }),
    );
    const digest = digestFromEvents(events);
    expect(digest[0].count).toBe(8);
    expect(digest[0].distinctTargets).toBe(8);
    expect(digest[0].samples).toHaveLength(SAMPLE_CAP);
    // newest-first: last event was logs/l7
    expect(digest[0].samples[0]).toBe('logs/l7');
  });

  test('write auth uid is captured as an identity', () => {
    const digest = digestFromEvents([
      write('orders/o1', 'create', { auth: { uid: 'carol' } }),
    ]);
    expect(digest[0].identities).toContain('carol');
  });

  test('repeated identity is not double-counted', () => {
    const digest = digestFromEvents([
      serviceMutation('auth', 'sign_in', { path: 'alice', at: 1 }),
      serviceMutation('auth', 'sign_in', { path: 'alice', at: 2 }),
    ]);
    expect(digest[0].count).toBe(2);
    expect(digest[0].identities).toEqual(['alice']);
  });
});

// ─── Ordering ───────────────────────────────────────────────────────────────

describe('ordering', () => {
  test('digest is newest-activity first by lastAt', () => {
    const digest = digestFromEvents([
      write('a/1', 'create', { at: 100 }), // firestore added /a
      serviceMutation('auth', 'sign_in', { path: 'z', at: 500 }), // auth
      write('b/1', 'create', { at: 300 }), // firestore added /b
    ]);
    expect(digest.map((d) => d.lastAt)).toEqual([500, 300, 100]);
    expect(digest[0].service).toBe('auth');
  });

  test('lastAt tracks the most recent contributing event in a burst', () => {
    const digest = digestFromEvents([
      write('users/a', 'create', { at: 10 }),
      write('users/b', 'create', { at: 99 }),
      write('users/c', 'create', { at: 50 }),
    ]);
    expect(digest[0].firstAt).toBe(10);
    expect(digest[0].lastAt).toBe(99);
  });
});

// ─── Skip rules (non-mutation events ignored) ───────────────────────────────

describe('non-mutation events are skipped', () => {
  test('request (read/allow), listener, snapshot, session_boundary produce no items', () => {
    const noise: SandboxEvent[] = [
      {
        kind: 'request',
        id: nextId(),
        at: 1,
        evalMs: 0,
        method: 'get',
        path: 'users/a',
        auth: null,
        result: 'allow',
        reasons: [],
        origin: 'user',
      } as SandboxEvent,
      {
        kind: 'request',
        id: nextId(),
        at: 2,
        evalMs: 0,
        method: 'create',
        path: 'users/a',
        auth: null,
        result: 'deny',
        reasons: [],
        origin: 'user',
      } as SandboxEvent,
      {
        kind: 'listener_attach',
        id: nextId(),
        at: 3,
        listenerId: 'l1',
        target: { kind: 'doc', path: 'users/a' },
        auth: null,
      } as SandboxEvent,
      {
        kind: 'session_boundary',
        id: nextId(),
        at: 4,
        phase: 'reset',
        priorOpCount: 0,
      } as SandboxEvent,
    ];
    expect(digestFromEvents(noise)).toHaveLength(0);
  });

  test('toMutation returns null for a denied request and an object for a write', () => {
    expect(
      toMutation({
        kind: 'request',
        id: 'x',
        at: 0,
        evalMs: 0,
        method: 'create',
        path: 'p/1',
        auth: null,
        result: 'deny',
        reasons: [],
        origin: 'user',
      } as SandboxEvent),
    ).toBeNull();
    expect(toMutation(write('p/1', 'create'))).not.toBeNull();
  });
});

// ─── Incremental fold parity ────────────────────────────────────────────────

describe('incremental fold parity', () => {
  test('foldDigest step-by-step matches digestFromEvents', () => {
    const events = [
      write('users/a', 'create', { at: 1 }),
      write('users/b', 'create', { at: 2 }),
      serviceMutation('storage', 'object_put', { path: 'f/x.png', at: 3 }),
    ];
    const state = emptyDigestState();
    for (const e of events) foldDigest(state, e);
    const incremental = [...state.buckets.values()]
      .map((b) => b.item)
      .sort((a, b) => b.lastAt - a.lastAt);
    expect(incremental).toEqual(digestFromEvents(events));
  });
});

// ─── Phrasing pluralisation ─────────────────────────────────────────────────

describe('phrasing pluralisation', () => {
  test('singular firestore write reads "doc added to /users"', () => {
    expect(
      phraseDigest(digestFromEvents([write('users/a', 'create')])[0]),
    ).toBe('doc added to /users');
  });

  test('single sign-out without identity falls back to count', () => {
    const digest = digestFromEvents([serviceMutation('auth', 'sign_out')]);
    expect(phraseDigest(digest[0])).toBe('1 user signed out');
  });
});
