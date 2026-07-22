/**
 * Messaging instance identity — per-app, per-sandbox, per-plane. Sandbox
 * target, BLOCKING run (explicit apps only).
 *
 * The mirror caches one instance per (sandbox, plane). This suite pins that
 * caching contract and the client/sw module boundary at the instance level:
 * the two planes are DISTINCT instances that share ONE per-sandbox broker
 * (production's one-service-worker-per-origin model). Routing correctness for
 * that shared broker lives in `sandbox-routing.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createAppForSandbox } from '../../src/app/internal.js';
import { initializeApp } from '../../src/app/index.js';
import { resetAppRegistryForTests } from '../../src/app/registry.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getMessaging, onMessage, sandbox as messagingSandbox } from '../../src/messaging/index.js';
import { getMessaging as getMessagingInSw, onBackgroundMessage } from '../../src/messaging/sw.js';

function sandboxApp() {
  // Distinct independent apps need distinct names — a default-name reuse
  // would collide (app/duplicate-app), exactly as firebase/app does. The
  // random suffix stays unique across the messaging test files (one process,
  // one shared app registry).
  return createAppForSandbox(initializeSandbox(), { projectId: 'messaging-test' }, `msg-${Math.random().toString(36).slice(2)}`);
}

describe('Messaging instance identity (sandbox)', () => {
  beforeEach(() => resetAppRegistryForTests());
  afterEach(() => resetAppRegistryForTests());

  it('returns the same client instance for repeated getMessaging on one app', () => {
    const app = sandboxApp();
    expect(getMessaging(app)).toBe(getMessaging(app));
  });

  it('returns distinct client instances for distinct apps', () => {
    expect(getMessaging(sandboxApp())).not.toBe(getMessaging(sandboxApp()));
  });

  it('exposes the bound app on the instance', () => {
    const app = sandboxApp();
    expect(getMessaging(app).app).toBe(app);
  });

  it('client and sw are distinct instances on the same app (module boundary)', () => {
    const app = sandboxApp();
    expect(getMessagingInSw(app)).not.toBe(getMessaging(app));
  });

  it('sw getMessaging is also cached per app', () => {
    const app = sandboxApp();
    expect(getMessagingInSw(app)).toBe(getMessagingInSw(app));
  });

  it('client + sw on the same app share ONE broker — a client-driven delivery reaches the sw handler', async () => {
    // Shared broker is observable end-to-end: register a background handler on
    // the sw instance, then drive a HIDDEN delivery through the CLIENT
    // instance's sandbox driver. One broker, so the sw handler fires.
    const app = sandboxApp();
    const client = getMessaging(app);
    const sw = getMessagingInSw(app);
    const background: unknown[] = [];
    onBackgroundMessage(sw, (p) => { background.push(p); });
    const result = await messagingSandbox.deliver(client, { visibilityState: 'hidden', data: { k: 'v' } });
    expect(background.length).toBe(1);
    expect(result.route).toBe('background');
  });

  it('distinct app handles over one sandbox share the messaging broker', async () => {
    const sandbox = initializeSandbox();
    const appA = createAppForSandbox(sandbox, { projectId: 'shared-messaging' }, 'msg-a');
    const appB = createAppForSandbox(sandbox, { projectId: 'shared-messaging' }, 'msg-b');
    const client = getMessaging(appA);
    const worker = getMessagingInSw(appB);
    const background: unknown[] = [];
    onBackgroundMessage(worker, (payload) => { background.push(payload); });

    await messagingSandbox.deliver(client, { visibilityState: 'hidden', data: { shared: 'yes' } });
    expect(background).toHaveLength(1);
  });

  it('separate sandboxes are isolated — a delivery on one reaches only its own handlers', async () => {
    const a = getMessaging(sandboxApp());
    const b = getMessaging(sandboxApp());
    const seenA: unknown[] = [];
    const seenB: unknown[] = [];
    onMessage(a, (p) => { seenA.push(p); });
    onMessage(b, (p) => { seenB.push(p); });
    await messagingSandbox.deliver(a, { visibilityState: 'visible', data: { k: 'v' } });
    expect(seenA.length).toBe(1);
    expect(seenB.length).toBe(0);
  });

  it('getMessaging() with no app resolves the Firebase default app', () => {
    const app = initializeApp({ projectId: 'messaging-default-test' });
    expect(getMessaging().app).toBe(app);
  });
});
