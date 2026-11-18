import { deleteApp, initializeApp } from 'firebase/app';
import { getBytes, getStorage, ref } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails } from '../../src/storage-probe-session.ts';

export const probe: Probe = {
  rig: 'client-storage',
  matrixRow: 'storage#57',
  rowIds: ['storage#57'],
  description:
    'firebase/storage getBytes(ref(storage)) on the root reference: observes client-side invalid-root-operation preflight with zero network requests.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        fetchCalls += 1;
        throw new Error('unexpected network fetch during root-reference getBytes preflight');
      },
      { preconnect: originalFetch.preconnect },
    );

    const app = initializeApp(
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      `client-storage-getbytes-root-${Date.now()}`,
    );

    try {
      const storage = getStorage(app);
      const rootRef = ref(storage);
      const rootFullPath = rootRef.fullPath;
      const rootName = rootRef.name;

      let threw = false;
      let threwSynchronously = false;
      let caughtError: unknown = null;

      try {
        const resultPromise = getBytes(rootRef);
        try {
          await resultPromise;
        } catch (asyncErr) {
          threw = true;
          caughtError = asyncErr;
        }
      } catch (syncErr) {
        threw = true;
        threwSynchronously = true;
        caughtError = syncErr;
      }

      const details = extractObservedErrorDetails(caughtError);
      return {
        rootFullPath,
        rootName,
        threw,
        threwSynchronously,
        ...details,
        fetchCalls,
      };
    } finally {
      globalThis.fetch = originalFetch;
      await deleteApp(app);
    }
  },
};
