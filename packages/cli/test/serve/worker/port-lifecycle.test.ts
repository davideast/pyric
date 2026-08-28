import { describe, expect, it } from 'bun:test';
import type { HostCtx, PortLike } from '../../../src/serve/worker/host.js';
import { createPortLifecycleManager } from '../../../src/serve/worker/port-lifecycle.js';

describe('PortLifecycleManager', () => {
  it('cleans up port immediately when context is already resolved', async () => {
    let cleanedPort: PortLike | null = null;
    const ctx = {
      subs: new Map(),
      disconnect: new Map(),
    } as unknown as HostCtx;

    const manager = createPortLifecycleManager();
    const port: PortLike = { postMessage() {} };

    // Register a subscription to verify cleanup
    let unsubscribed = false;
    ctx.subs.set(port, new Map([['sub1', () => { unsubscribed = true; }]]));

    manager.onPortClosed(port, ctx);

    // Wait a tick for void promise
    await new Promise((r) => setTimeout(r, 10));

    expect(unsubscribed).toBe(true);
    expect(unsubscribed).toBe(true);
    expect(ctx.subs.has(port)).toBe(false);
    expect(manager.isPortClosed(port)).toBe(true);
  });

  it('queues closed port when context is null and drains it upon resolution', async () => {
    const manager = createPortLifecycleManager();
    const port: PortLike = { postMessage() {} };

    // Tab closes while context is still in flight (currentCtx === null)
    manager.onPortClosed(port, null);
    expect(manager.isPortClosed(port)).toBe(true);

    const ctx = {
      subs: new Map(),
      disconnect: new Map(),
    } as unknown as HostCtx;

    let unsubscribed = false;
    ctx.subs.set(port, new Map([['sub1', () => { unsubscribed = true; }]]));

    // Context finishes loading and drains deferred closed ports
    manager.drainClosedPorts(ctx);

    await new Promise((r) => setTimeout(r, 10));

    expect(unsubscribed).toBe(true);
    expect(ctx.subs.has(port)).toBe(false);
    // Port remains permanently marked closed so in-flight queued frames are ignored
    expect(manager.isPortClosed(port)).toBe(true);
  });

  it('drops messages when isPortClosed is true', () => {
    const manager = createPortLifecycleManager();
    const port: PortLike = { postMessage() {} };

    expect(manager.isPortClosed(port)).toBe(false);
    manager.onPortClosed(port, null);
    expect(manager.isPortClosed(port)).toBe(true);
  });
});
