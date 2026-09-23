import { describe, expect, it } from 'bun:test';
import { stateForSummary } from '../../src/serve/state-summary.js';
import type { StateSection, StateStore } from '../../src/serve/state-store.js';

function recordingStore(): { store: StateStore; reads: string[] } {
  const reads: string[] = [];
  const sections: Record<StateSection, unknown> = {
    firestore: null,
    auth: { users: [{ uid: 'alice' }, { uid: 'bob' }] },
    storage: [{ metadata: {}, blobType: 'audio/wav', dataBase64: 'AAAA' }],
  };
  const store: StateStore = {
    projectDir: '/project',
    path: '/project/.pyric/state/hosted/state.sqlite',
    backupPath: '/project/.pyric/state/hosted.archive',
    exists: () => true,
    load: () => { reads.push('load'); return { version: 1, firestore: null, auth: sections.auth as never, storage: [] }; },
    readSection: (section) => { reads.push(section); return sections[section]; },
    writeSection: () => {},
  };
  return { store, reads };
}

describe('stateForSummary', () => {
  it('reads a hosted store by section and never reads its Storage objects', () => {
    const { store, reads } = recordingStore();
    const state = stateForSummary(store, { hosted: true });
    expect(reads).toEqual(['firestore', 'auth']);
    expect(state?.auth?.users.length).toBe(2);
    expect(state?.storage).toBeUndefined();
  });

  it('loads a browser state file whole, as before', () => {
    const { store, reads } = recordingStore();
    stateForSummary(store, { hosted: false });
    expect(reads).toEqual(['load']);
  });

  it('reports nothing restored when the store is empty', () => {
    const { store, reads } = recordingStore();
    const empty: StateStore = { ...store, exists: () => false };
    expect(stateForSummary(empty, { hosted: true })).toBeNull();
    expect(stateForSummary(undefined, { hosted: true })).toBeNull();
    expect(reads).toEqual([]);
  });
});
