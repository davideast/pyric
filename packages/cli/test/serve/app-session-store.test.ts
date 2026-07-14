import { beforeEach, describe, expect, it } from 'bun:test';
import { deleteApp, initializeApp } from 'pyric/app';
import { resetAppRegistryForTests } from '../../../pyric/dist/app/registry.js';
import { createAppSessionStores } from '../../src/serve/entries/app-session-store.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  };
}

beforeEach(() => resetAppRegistryForTests());

describe('served app SessionStore ownership', () => {
  it('evicts the deleted app object while preserving the name-keyed persisted session', async () => {
    const local = memoryStorage();
    const session = memoryStorage();
    const registry = createAppSessionStores({
      local: local.storage,
      session: session.storage,
    });
    const options = { projectId: 'served-session-store-lifecycle' };
    const first = initializeApp(options, 'named');
    const firstStore = registry.forApp(first);
    firstStore.save('persisted-user');

    await deleteApp(first);
    const replacement = initializeApp(options, 'named');
    const replacementStore = registry.forApp(replacement);

    expect(replacementStore).not.toBe(firstStore);
    expect(replacementStore.load()).toEqual({ uid: 'persisted-user' });
  });
});
