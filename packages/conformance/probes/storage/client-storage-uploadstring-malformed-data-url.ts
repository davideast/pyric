import { deleteApp, initializeApp } from 'firebase/app';
import { getStorage, ref, uploadString } from 'firebase/storage';
import type { Probe } from '../../rigs/types.ts';
import { extractObservedErrorDetails } from '../../src/storage-probe-session.ts';

interface MalformedDataUrlCaseObservation {
  threw: boolean;
  threwSynchronously: boolean;
  code: string | null;
  errorName: string | null;
  isFirebaseError: boolean;
  mentionsDataUrlFormat: boolean;
  fetchCalls: number;
}

async function observeMalformedCase(
  callUpload: () => Promise<unknown>,
  readFetchCalls: () => number,
): Promise<MalformedDataUrlCaseObservation> {
  const beforeCalls = readFetchCalls();
  let threw = false;
  let threwSynchronously = false;
  let caught: unknown = null;

  try {
    const pending = callUpload();
    try {
      await pending;
    } catch (asyncErr) {
      threw = true;
      caught = asyncErr;
    }
  } catch (syncErr) {
    threw = true;
    threwSynchronously = true;
    caught = syncErr;
  }

  const details = extractObservedErrorDetails(caught);
  let mentionsDataUrlFormat = false;
  if (typeof details.message === 'string') {
    mentionsDataUrlFormat = details.message.includes('data_url');
  }

  return {
    threw,
    threwSynchronously,
    code: details.code,
    errorName: details.errorName,
    isFirebaseError: details.isFirebaseError,
    mentionsDataUrlFormat,
    fetchCalls: readFetchCalls() - beforeCalls,
  };
}

export const probe: Probe = {
  rig: 'client-storage',
  matrixRow: 'storage#45',
  rowIds: ['storage#45'],
  description:
    'firebase/storage uploadString(ref, value, "data_url") on malformed data URLs (missing data: prefix, missing comma, invalid percent-encoding): observes client-side error class, error code, synchronous vs async rejection, and zero network fetches.',
  async observe() {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = Object.assign(
      async (): Promise<Response> => {
        fetchCalls += 1;
        throw new Error('unexpected network fetch during malformed data_url validation');
      },
      { preconnect: originalFetch.preconnect },
    );

    const app = initializeApp(
      { projectId: 'demo-storage-probe', storageBucket: 'buckets-default' },
      `client-storage-malformed-dataurl-${Date.now()}`,
    );

    try {
      const storage = getStorage(app);
      const itemRef = ref(storage, 'items/malformed.txt');
      const readFetchCalls = (): number => fetchCalls;

      const missingDataPrefix = await observeMalformedCase(
        () => uploadString(itemRef, 'not-a-data-url', 'data_url'),
        readFetchCalls,
      );
      const missingComma = await observeMalformedCase(
        () => uploadString(itemRef, 'data:text/plain;base64-no-comma', 'data_url'),
        readFetchCalls,
      );
      const invalidPercentEncoding = await observeMalformedCase(
        () => uploadString(itemRef, 'data:text/plain,bad%ZZ', 'data_url'),
        readFetchCalls,
      );

      return {
        missingDataPrefix,
        missingComma,
        invalidPercentEncoding,
      };
    } finally {
      globalThis.fetch = originalFetch;
      await deleteApp(app);
    }
  },
};
