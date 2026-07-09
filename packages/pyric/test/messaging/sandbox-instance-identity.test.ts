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
import { describe, expect, it } from 'bun:test';
import { initializeApp } from '../../src/app/index.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getMessaging, onMessage, sandbox as messagingSandbox } from '../../src/messaging/index.js';
import { getMessaging as getMessagingInSw, onBackgroundMessage } from '../../src/messaging/sw.js';

function sandboxApp() {
  return initializeApp({ sandbox: initializeSandbox() });
}

describe('Messaging instance identity (sandbox)', () => {
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

  it('getMessaging() with no app refuses outside the climb (WIP-isolation contract)', () => {
    // The blocking run never sets PYRIC_CLIMB, so the bare call must refuse
    // rather than silently mint a sandbox. Under the climb flag the mirror
    // provides a module-default sandbox instead; both sides pinned so this
    // file is honest in either run mode (it is not itself flag-gated).
    if (process.env.PYRIC_CLIMB === '1') {
      expect(getMessaging().app).toBeDefined();
    } else {
      expect(() => getMessaging()).toThrow(/without an app/);
    }
  });
});
