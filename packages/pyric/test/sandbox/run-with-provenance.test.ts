/**
 * Tests for `Sandbox.runWithProvenance` — the ambient provenance window
 * the serve worker uses to tag Studio-issued ops (`actor: { kind:
 * 'studio' }`) and stamp the auth lens an op ran under, at the ONE
 * emit choke-point ({@link SandboxImpl.emitEvent}).
 *
 * The contract under test (types.ts):
 *   - events emitted synchronously inside the window get the ambient
 *     fields as defaults;
 *   - fields the event or an explicit per-emit override carries win;
 *   - the window restores on exit (including on throw) and nests
 *     (innermost wins per field);
 *   - DEFERRED emissions (microtask listener deliveries) are outside
 *     the window — a listener re-eval must not inherit the actor of
 *     whoever's write happened to trigger it.
 */
import { describe, it, expect } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getInternalEnv } from 'pyric/sandbox/internal';
import type { SandboxEvent } from 'pyric/sandbox';
import { getFirestore, collection, onSnapshot } from 'pyric/firestore';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /notes/{id} {
      allow read, write: if true;
    }
  }
}`;

function makeSandbox() {
  const sandbox = initializeSandbox();
  const env = getInternalEnv(sandbox);
  env.seed({ rules: RULES });
  return { sandbox, env };
}

describe('sandbox.runWithProvenance', () => {
  it('stamps ambient actor on events emitted synchronously in the window', () => {
    const { sandbox, env } = makeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    sandbox.runWithProvenance!({ actor: { kind: 'studio' } }, () => {
      env.execute({ method: 'set', path: 'notes/n1', auth: null, data: { body: 'hi' } });
    });

    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.actor).toEqual({ kind: 'studio' });
      // Unnamed fields still get the global defaults.
      expect(e.authLens).toEqual({ mode: 'app-session' });
    }
  });

  it('stamps ambient authLens alongside actor', () => {
    const { sandbox, env } = makeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    sandbox.runWithProvenance!(
      { actor: { kind: 'studio' }, authLens: { mode: 'admin' } },
      () => {
        env.execute({ method: 'get', path: 'notes/n1', auth: null });
      },
    );

    for (const e of events) {
      expect(e.actor).toEqual({ kind: 'studio' });
      expect(e.authLens).toEqual({ mode: 'admin' });
    }
  });

  it('restores the previous window on exit, including on throw', () => {
    const { sandbox, env } = makeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    expect(() =>
      sandbox.runWithProvenance!({ actor: { kind: 'studio' } }, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');

    env.execute({ method: 'set', path: 'notes/n2', auth: null, data: { body: 'after' } });
    for (const e of events) {
      expect(e.actor).toEqual({ kind: 'app' });
    }
  });

  it('nests: the innermost window wins per field, outer restores after', () => {
    const { sandbox, env } = makeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    sandbox.runWithProvenance!(
      { actor: { kind: 'studio' }, authLens: { mode: 'admin' } },
      () => {
        sandbox.runWithProvenance!({ actor: { kind: 'agent', name: 'a1' } }, () => {
          env.execute({ method: 'set', path: 'notes/inner', auth: null, data: { v: 1 } });
        });
        env.execute({ method: 'set', path: 'notes/outer', auth: null, data: { v: 2 } });
      },
    );

    const inner = events.filter((e) => 'path' in e && (e as { path?: string }).path === 'notes/inner');
    const outer = events.filter((e) => 'path' in e && (e as { path?: string }).path === 'notes/outer');
    expect(inner.length).toBeGreaterThan(0);
    expect(outer.length).toBeGreaterThan(0);
    for (const e of inner) {
      expect(e.actor).toEqual({ kind: 'agent', name: 'a1' });
      // Inner window didn't name authLens — the outer window's value holds.
      expect(e.authLens).toEqual({ mode: 'admin' });
    }
    for (const e of outer) expect(e.actor).toEqual({ kind: 'studio' });
  });

  it('does not leak into deferred listener deliveries (microtask drains)', async () => {
    const { sandbox, env } = makeSandbox();
    const events: SandboxEvent[] = [];
    sandbox.onEvent((e) => events.push(e));

    // An app listener on the collection: its re-eval fires off-stack after
    // a write. A Studio-tagged write must not stamp the listener's events.
    const db = getFirestore(sandbox.withAuth(null));
    const unsub = onSnapshot(collection(db, 'notes'), () => {});
    await Promise.resolve(); // drain the initial delivery

    events.length = 0;
    sandbox.runWithProvenance!({ actor: { kind: 'studio' } }, () => {
      env.execute({ method: 'set', path: 'notes/n3', auth: null, data: { body: 'wake' } });
    });
    // Let the deferred delivery drain.
    await Promise.resolve();
    await Promise.resolve();

    // The write's OWN events (synchronous, user-origin) carry the tag; the
    // listener's deferred re-eval request + delivery events do not — they
    // belong to the listener's owner, not the write that woke it.
    const writeEvents = events.filter(
      (e) => (e.kind === 'request' || e.kind === 'write') &&
        (e as { origin?: string }).origin !== 'listener',
    );
    const deferred = events.filter(
      (e) =>
        e.kind === 'snapshot_delivery' ||
        (e.kind === 'request' && (e as { origin?: string }).origin === 'listener'),
    );
    expect(writeEvents.length).toBeGreaterThan(0);
    for (const e of writeEvents) expect(e.actor).toEqual({ kind: 'studio' });
    expect(deferred.length).toBeGreaterThan(0);
    for (const e of deferred) expect(e.actor).toEqual({ kind: 'app' });
    unsub();
  });
});
