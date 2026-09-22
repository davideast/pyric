import { describe, expect, it } from 'bun:test';
import type { ClientDb } from '../../../../src/serve/worker/client.js';
import { ownClientUntilPagehide } from '../../../../src/serve/worker/client/pagehide.js';

function pagehideHarness() {
  const listeners = new Set<(event: Event) => void>();
  return {
    events: {
      addEventListener(_type: 'pagehide', listener: (event: Event) => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: 'pagehide', listener: (event: Event) => void) {
        listeners.delete(listener);
      },
    },
    dispatch(persisted: boolean) {
      for (const listener of listeners) listener({ persisted } as PageTransitionEvent);
    },
    listenerCount: () => listeners.size,
  };
}

describe('SharedWorker page lifecycle', () => {
  it('disconnects once on permanent pagehide and preserves bfcache sessions', async () => {
    const harness = pagehideHarness();
    const client = {} as ClientDb;
    let disconnects = 0;
    const lifecycle = ownClientUntilPagehide(client, harness.events, async (actual) => {
      expect(actual).toBe(client);
      disconnects += 1;
    });

    harness.dispatch(true);
    expect(disconnects).toBe(0);

    harness.dispatch(false);
    harness.dispatch(false);
    await Promise.resolve();
    expect(disconnects).toBe(1);

    lifecycle.dispose();
    expect(harness.listenerCount()).toBe(0);
  });

  it('safely no-ops in environments without addEventListener without throwing', async () => {
    const client = {} as ClientDb;
    let disconnects = 0;
    const dummyScope = {};

    const lifecycle = ownClientUntilPagehide(client, dummyScope as any, async () => {
      disconnects += 1;
    });

    lifecycle.dispose();
    await lifecycle.disconnect();
    expect(disconnects).toBe(1);
  });

  it('skips event listener attachment on service worker scopes even if window is simulated', async () => {
    const client = {} as ClientDb;
    let listenersAdded = 0;
    const swScope = {
      registration: {},
      clients: {},
      addEventListener() {
        listenersAdded += 1;
        throw new Error("Event handler of 'pagehide' event must be added on the initial evaluation of worker script.");
      },
      removeEventListener() {},
    };

    expect(() => {
      const lifecycle = ownClientUntilPagehide(client, swScope as any);
      lifecycle.dispose();
    }).not.toThrow();
    expect(listenersAdded).toBe(0);
  });
});

