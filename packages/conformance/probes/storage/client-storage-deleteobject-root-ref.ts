import { deleteApp, initializeApp } from 'firebase/app';
import { deleteObject, getStorage, ref } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails } from '../../src/storage-probe-session.ts';

export const probe: Probe = {
  rig: 'client-storage',
  matrixRow: 'storage#65',
  rowIds: ['storage#65'],
  description:
    'firebase/storage deleteObject(ref(storage)) on the root reference: observes client-side invalid-root-operation preflight with zero network requests.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        fetchCalls += 1;
        throw new Error('unexpected network fetch during root-reference deleteObject preflight');
      },
      { preconnect: originalFetch.preconnect },
    );

    const app = initializeApp(
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      `client-storage-deleteobject-root-${Date.now()}`,
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
        const resultPromise = deleteObject(rootRef);
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
