/**
 * `onMessage` subscribe/unsubscribe semantics — client mirror, sandbox target.
 *
 * These are the SDK-shape behaviors BETWEEN the conformance rows: the oracle
 * rows (`oracle-conformance.test.ts`) pin the observed production facts (the
 * envelope keys, the visibility routing rule); this suite owns the listener
 * mechanics the mirror layers on top. Runs BLOCKING (no PYRIC_CLIMB gate):
 * every case passes an explicit sandbox-backed app, so nothing depends on the
 * climb-only default-app path.
 *
 * Precedent: `test/auth/sandbox-listeners.test.ts`. One divergence from that
 * precedent is pinned below (a throwing handler DOES propagate here) — see the
 * `throwing handler` case; it is documented, not silently accepted.
 */
import { describe, expect, it } from 'bun:test';
import { createAppForSandbox } from '../../src/app/internal.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import {
  getMessaging,
  onMessage,
  sandbox as messagingSandbox,
  type MessagePayload,
} from '../../src/messaging/index.js';

/** A fresh sandbox-backed app — isolates each case's broker + instance state. */
function sandboxApp() {
  // Distinct independent apps need distinct names — a default-name reuse
  // would collide (app/duplicate-app), exactly as firebase/app does. The
  // random suffix stays unique across the messaging test files (one process,
  // one shared app registry).
  return createAppForSandbox(initializeSandbox(), { projectId: 'messaging-test' }, `msg-${Math.random().toString(36).slice(2)}`);
}

describe('onMessage (sandbox)', () => {
  it('delivers a visible-client message to the subscribed handler', async () => {
    const messaging = getMessaging(sandboxApp());
    const seen: MessagePayload[] = [];
    const unsub = onMessage(messaging, (p) => { seen.push(p); });
    expect(typeof unsub).toBe('function');
    const result = await messagingSandbox.deliver(messaging, {
      visibilityState: 'visible',
      data: { k: 'v' },
    });
    expect(seen.length).toBe(1);
    expect(result.route).toBe('foreground');
    expect(result.handlerCount).toBe(1);
  });

  it('unsubscribe stops further delivery', async () => {
    const messaging = getMessaging(sandboxApp());
    const seen: MessagePayload[] = [];
    const unsub = onMessage(messaging, (p) => { seen.push(p); });
    await messagingSandbox.deliver(messaging, { visibilityState: 'visible', data: { k: '1' } });
    unsub();
    const after = await messagingSandbox.deliver(messaging, { visibilityState: 'visible', data: { k: '2' } });
    expect(seen.length).toBe(1); // only the pre-unsubscribe delivery
    expect(after.handlerCount).toBe(0);
  });

  it('multiple handlers all fire; the observer object form works alongside the fn form', async () => {
    const messaging = getMessaging(sandboxApp());
    let a = 0;
    let b = 0;
    onMessage(messaging, () => { a++; });
    onMessage(messaging, { next: () => { b++; }, error: () => {}, complete: () => {} });
    const result = await messagingSandbox.deliver(messaging, { visibilityState: 'visible', data: { k: 'v' } });
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(result.handlerCount).toBe(2);
  });

  it('each handler receives its own copy — a mutating handler cannot corrupt a sibling', async () => {
    // The broker structuredClones the payload per handler; a consumer that
    // mutates its envelope must not change what the next handler observes.
    const messaging = getMessaging(sandboxApp());
    let secondSaw: string | undefined;
    onMessage(messaging, (p) => { (p.data as Record<string, string>).k = 'MUTATED'; });
    onMessage(messaging, (p) => { secondSaw = p.data?.k; });
    await messagingSandbox.deliver(messaging, { visibilityState: 'visible', data: { k: 'orig' } });
    expect(secondSaw).toBe('orig');
  });

  it('a throwing handler does not block other handlers', async () => {
    // Same isolation contract as `test/auth/sandbox-listeners.test.ts`'s
    // "a throwing observer does not block other observers": the broker's
    // `route()` guards each handler, so one consumer's throw neither
    // rejects the delivery nor starves its siblings.
    const messaging = getMessaging(sandboxApp());
    const order: string[] = [];
    onMessage(messaging, () => { order.push('first'); throw new Error('boom'); });
    onMessage(messaging, () => { order.push('second'); });
    await messagingSandbox.deliver(messaging, { visibilityState: 'visible', data: { k: 'v' } });
    expect(order).toEqual(['first', 'second']);
  });

  it('rejects a Messaging instance not produced by this module', () => {
    // `onMessage` resolves per-instance broker state; a foreign object has none.
    const foreign = { app: sandboxApp() } as ReturnType<typeof getMessaging>;
    expect(() => onMessage(foreign, () => {})).toThrow(/was not produced by/);
  });
});
