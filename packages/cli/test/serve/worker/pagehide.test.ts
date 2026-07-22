import { describe, expect, it } from 'bun:test';
import type { ClientDb } from '../../../src/serve/worker/client.js';
import { ownClientUntilPagehide } from '../../../src/serve/worker/client/pagehide.js';

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
});
