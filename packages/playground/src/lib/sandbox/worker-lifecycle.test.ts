import { describe, expect, it } from 'bun:test';
import type { ClientDb } from '@pyric/cli/serve/worker';
import { registerWorkerPagehideDisconnect } from './worker-lifecycle';

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

describe('playground SharedWorker lifecycle', () => {
  it('disconnects once on permanent pagehide and preserves bfcache sessions', async () => {
    const harness = pagehideHarness();
    const client = {} as ClientDb;
    let disconnects = 0;
    const unregister = registerWorkerPagehideDisconnect(client, harness.events, async (actual) => {
      expect(actual).toBe(client);
      disconnects += 1;
    });

    harness.dispatch(true);
    expect(disconnects).toBe(0);

    harness.dispatch(false);
    harness.dispatch(false);
    await Promise.resolve();
    expect(disconnects).toBe(1);

    unregister();
    expect(harness.listenerCount()).toBe(0);
  });
});
