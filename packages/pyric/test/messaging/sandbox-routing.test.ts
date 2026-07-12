/**
 * Visibility-driven foreground/background routing through the sandbox driver
 * namespace, and the sw/client module boundary. Sandbox target, BLOCKING.
 *
 * The oracle row `messaging-web-visibility-routing` pins the production RULE
 * (foreground iff a window client is visible, keyed on visibility never
 * focus). This suite owns the mirror mechanics around it: visibility-state
 * TRANSITIONS across successive deliveries, exclusive routing (exactly one
 * plane per delivery), and that each entry exposes the correct handler for its
 * route — `onMessage` on the client, `onBackgroundMessage` on the sw — over
 * the one shared broker.
 */
import { describe, expect, it } from 'bun:test';
import { initializeApp } from '../../src/app/index.js';
import { initializeSandbox } from '../../src/sandbox/index.js';
import { getMessaging, onMessage, sandbox as messagingSandbox } from '../../src/messaging/index.js';
import {
  getMessaging as getMessagingInSw,
  onBackgroundMessage,
  sandbox as swSandbox,
} from '../../src/messaging/sw.js';

function sandboxApp() {
  // Distinct independent apps need distinct names — a default-name reuse
  // would collide (app/duplicate-app), exactly as firebase/app does. The
  // random suffix stays unique across the messaging test files (one process,
  // one shared app registry).
  return initializeApp({ sandbox: initializeSandbox() }, `msg-${Math.random().toString(36).slice(2)}`);
}

/** Register a foreground + background counter over one shared-broker app. */
function wired() {
  const app = sandboxApp();
  const client = getMessaging(app);
  const sw = getMessagingInSw(app);
  const foreground: unknown[] = [];
  const background: unknown[] = [];
  onMessage(client, (p) => { foreground.push(p); });
  onBackgroundMessage(sw, (p) => { background.push(p); });
  return { client, foreground, background };
}

describe('visibility routing (sandbox)', () => {
  it('a visible-client delivery routes to onMessage only', async () => {
    const { client, foreground, background } = wired();
    const result = await messagingSandbox.deliver(client, { visibilityState: 'visible', data: { k: 'v' } });
    expect(result.route).toBe('foreground');
    expect(foreground.length).toBe(1);
    expect(background.length).toBe(0);
  });

  it('a hidden-client delivery routes to onBackgroundMessage only', async () => {
    const { client, foreground, background } = wired();
    const result = await messagingSandbox.deliver(client, { visibilityState: 'hidden', data: { k: 'v' } });
    expect(result.route).toBe('background');
    expect(foreground.length).toBe(0);
    expect(background.length).toBe(1);
  });

  it('follows visibility TRANSITIONS across successive deliveries', async () => {
    const { client, foreground, background } = wired();
    await messagingSandbox.deliver(client, { visibilityState: 'visible', data: { k: '1' } });
    await messagingSandbox.deliver(client, { visibilityState: 'hidden', data: { k: '2' } });
    await messagingSandbox.deliver(client, { visibilityState: 'visible', data: { k: '3' } });
    expect(foreground.length).toBe(2);
    expect(background.length).toBe(1);
  });

  it('remembers the last-set visibility when a delivery omits visibilityState', async () => {
    // The driver only mutates client visibility when the spec carries it; an
    // omitted spec inherits the standing state (a hidden page stays hidden).
    const { client, foreground, background } = wired();
    await messagingSandbox.deliver(client, { visibilityState: 'hidden', data: { k: '1' } });
    await messagingSandbox.deliver(client, { data: { k: '2' } }); // no visibilityState
    expect(background.length).toBe(2);
    expect(foreground.length).toBe(0);
  });

  it('routing is exclusive — never both planes for one delivery', async () => {
    const { client, foreground, background } = wired();
    for (const state of ['visible', 'hidden', 'visible', 'hidden'] as const) {
      await messagingSandbox.deliver(client, { visibilityState: state, data: { k: state } });
    }
    expect(foreground.length + background.length).toBe(4);
    expect(foreground.length).toBe(2);
    expect(background.length).toBe(2);
  });

  it('the sw driver drives the same shared broker as the client driver', async () => {
    // Delivering through the SW instance's own `sandbox.deliver` reaches the
    // client's onMessage handler when visible — one broker, either driver.
    const app = sandboxApp();
    const client = getMessaging(app);
    const sw = getMessagingInSw(app);
    const foreground: unknown[] = [];
    onMessage(client, (p) => { foreground.push(p); });
    const result = await swSandbox.deliver(sw, { visibilityState: 'visible', data: { k: 'v' } });
    expect(result.route).toBe('foreground');
    expect(foreground.length).toBe(1);
  });
});
