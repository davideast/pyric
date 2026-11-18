/**
 * Served-entry + SharedWorker conformance for `listAll(ref)` (`storage#68..74, #76, #77a`):
 *   - `storage-listall-empty-and-result-shape` (`storage#68, #69, #76`)
 *   - `storage-listall-hierarchy-dedup-and-self-exclusion` (`storage#70, #71, #74`)
 *   - `storage-listall-lexicographic-order` (`storage#72, #73`)
 *   - `storage-listall-rules-enforcement` (`storage#77a`)
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp, FirebaseError } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { replaceStorageRules } from 'pyric/storage/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

function loadBehavior(name: string): Record<string, unknown> {
  const fileUrl = new URL(
    `../../../../conformance/observations/storage/${name}.json`,
    import.meta.url,
  );
  const parsed = JSON.parse(readFileSync(fileUrl, 'utf8')) as {
    behavior: Record<string, unknown>;
  };
  return parsed.behavior;
}

interface ListedRefExpectation {
  name: string;
  scrubbedFullPath: string;
  storageMatchesHandle: boolean;
  bucketMatchesHandle: boolean;
  parentMatchesScannedRef: boolean;
  rootFullPath: string;
  toStringMatchesGsUri: boolean;
}

interface ListAttemptExpectation {
  threw: boolean;
  code: string | null;
  isFirebaseError: boolean;
  itemNames: string[];
}

let appSeq = 0;

describe('served entry + SharedWorker listAll() parity (storage#68..74, #76, #77a)', () => {
  let restoreSharedWorker: () => void = () => {};

  beforeEach(() => {
    const previous = (globalThis as { SharedWorker?: unknown }).SharedWorker;
    restoreSharedWorker = () => {
      (globalThis as { SharedWorker?: unknown }).SharedWorker = previous;
    };
  });

  afterEach(() => {
    restoreSharedWorker();
  });

  async function setupServedStorage() {
    const ctx = await makeHostCtx();

    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          void handleMessage(ctx, hostPortLike, event.data as InboundMessage);
        };
        this.port = clientPort;
      }
    };

    const servedStorage = await import('../../../src/serve/entries/storage.js');
    const servedAuth = await import('../../../src/serve/entries/auth.js');
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage', storageBucket: 'buckets-default' },
      `served-listall-${++appSeq}`,
    );
    const storage = servedStorage.getStorage(app);
    const auth = servedAuth.getAuth(app);

    return {
      ctx,
      servedStorage,
      servedAuth,
      storage,
      auth,
      cleanup: async () => {
        await deleteApp(app);
        ctx.sandbox.dispose();
      },
    };
  }

  test('storage#68, #69, #76: listAll(ref) replays empty/populated ListResult and full StorageReference properties', async () => {
    const obs = loadBehavior('storage-listall-empty-and-result-shape');
    const session = await setupServedStorage();
    try {
      const emptyExpected = obs.emptyDirectory as {
        itemCount: number;
        prefixCount: number;
        nextPageTokenIsUndefined: boolean;
        hasNextPageTokenOwnProperty: boolean;
      };
      const emptyRef = session.servedStorage.ref(
        session.storage,
        'pyric_oracle/<runId>/listall-shape-empty',
      );
      const emptyRes = await session.servedStorage.listAll(emptyRef);
      const emptyRaw = emptyRes as unknown as Record<string, unknown>;
      expect(emptyRes.items.length).toBe(emptyExpected.itemCount);
      expect(emptyRes.prefixes.length).toBe(emptyExpected.prefixCount);
      expect(emptyRaw.nextPageToken === undefined).toBe(emptyExpected.nextPageTokenIsUndefined);
      expect(Object.prototype.hasOwnProperty.call(emptyRaw, 'nextPageToken')).toBe(
        emptyExpected.hasNextPageTokenOwnProperty,
      );

      await session.servedStorage.uploadBytes(
        session.servedStorage.ref(
          session.storage,
          'pyric_oracle/<runId>/listall-shape-populated/direct.bin',
        ),
        new Uint8Array([0x01]),
      );
      await session.servedStorage.uploadBytes(
        session.servedStorage.ref(
          session.storage,
          'pyric_oracle/<runId>/listall-shape-populated/nested-folder/child.bin',
        ),
        new Uint8Array([0x01]),
      );

      const populatedExpected = obs.populatedDirectory as {
        itemCount: number;
        prefixCount: number;
        nextPageTokenIsUndefined: boolean;
        hasNextPageTokenOwnProperty: boolean;
        items: ListedRefExpectation[];
        prefixes: ListedRefExpectation[];
      };
      const popRef = session.servedStorage.ref(
        session.storage,
        'pyric_oracle/<runId>/listall-shape-populated',
      );
      const popRes = await session.servedStorage.listAll(popRef);
      const popRaw = popRes as unknown as Record<string, unknown>;
      expect(popRes.items.length).toBe(populatedExpected.itemCount);
      expect(popRes.prefixes.length).toBe(populatedExpected.prefixCount);
      expect(popRaw.nextPageToken === undefined).toBe(populatedExpected.nextPageTokenIsUndefined);
      expect(Object.prototype.hasOwnProperty.call(popRaw, 'nextPageToken')).toBe(
        populatedExpected.hasNextPageTokenOwnProperty,
      );

      const checkShape = (
        actual: (typeof popRes.items)[number],
        expected: ListedRefExpectation,
      ) => {
        expect(actual.name).toBe(expected.name);
        expect(actual.fullPath).toBe(expected.scrubbedFullPath);
        expect(actual.storage === session.storage).toBe(expected.storageMatchesHandle);
        expect(actual.bucket === session.storage.bucket).toBe(expected.bucketMatchesHandle);
        let parentMatches = false;
        if (actual.parent !== null) {
          parentMatches = actual.parent.fullPath === popRef.fullPath;
        }
        expect(parentMatches).toBe(expected.parentMatchesScannedRef);
        expect(actual.root.fullPath).toBe(expected.rootFullPath);
        const expectedUri = `gs://${session.storage.bucket}/${actual.fullPath}`;
        expect(actual.toString() === expectedUri).toBe(expected.toStringMatchesGsUri);
      };

      checkShape(popRes.items[0], populatedExpected.items[0]);
      checkShape(popRes.prefixes[0], populatedExpected.prefixes[0]);
    } finally {
      await session.cleanup();
    }
  });

  test('storage#70..74: listAll(ref) replays self-exclusion, non-recursion, prefix dedup, and lexicographic sort', async () => {
    const hierObs = loadBehavior('storage-listall-hierarchy-dedup-and-self-exclusion');
    const orderObs = loadBehavior('storage-listall-lexicographic-order');
    const session = await setupServedStorage();
    try {
      const { servedStorage, storage } = session;
      const upload = (path: string) =>
        servedStorage.uploadBytes(servedStorage.ref(storage, path), new Uint8Array([0x41]));

      await upload('scan-tree');
      await upload('scan-tree/direct-two.bin');
      await upload('scan-tree/direct-one.bin');
      await upload('scan-tree/shared-folder/part-a.bin');
      await upload('scan-tree/shared-folder/part-b.bin');
      await upload('scan-tree/shared-folder/part-c.bin');
      await upload('scan-tree/deep-folder/nested/grandchild.bin');

      const exactMd = await servedStorage.getMetadata(servedStorage.ref(storage, 'scan-tree'));
      expect(exactMd.size > 0).toBe(hierObs.exactPrefixObjectExists as boolean);

      const listed = await servedStorage.listAll(servedStorage.ref(storage, 'scan-tree'));
      const fullPaths = listed.items.map((item) => item.fullPath);
      expect(fullPaths.includes('scan-tree')).toBe(hierObs.scannedRefIncludedInItems as boolean);
      expect(fullPaths.some((p) => p.slice('scan-tree/'.length).includes('/'))).toBe(
        hierObs.grandchildrenIncludedInItems as boolean,
      );
      expect(listed.items.map((item) => item.name)).toEqual(hierObs.itemNames as string[]);
      expect(listed.prefixes.map((prefix) => prefix.name)).toEqual(hierObs.prefixNames as string[]);

      for (const itemName of orderObs.uploadedItemOrder as string[]) {
        await upload(`listall-order/${itemName}`);
      }
      for (const prefixName of orderObs.uploadedPrefixOrder as string[]) {
        await upload(`listall-order/${prefixName}/leaf.bin`);
      }

      const ordered = await servedStorage.listAll(servedStorage.ref(storage, 'listall-order'));
      expect(ordered.items.map((item) => item.name)).toEqual(
        orderObs.observedItemNames as string[],
      );
      expect(ordered.prefixes.map((prefix) => prefix.name)).toEqual(
        orderObs.observedPrefixNames as string[],
      );
    } finally {
      await session.cleanup();
    }
  });

  test('storage#77a: listAll(ref) enforces read rules across SharedWorker Auth + Storage', async () => {
    const obs = loadBehavior('storage-listall-rules-enforcement');
    const session = await setupServedStorage();
    try {
      await replaceStorageRules(
        session.ctx.sandbox,
        `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /pyric_oracle/{allPaths=**} {
      allow read, write: if request.auth != null;
    }
  }
}`,
      );

      await session.servedAuth.signInAnonymously(session.auth);
      await session.servedStorage.uploadBytes(
        session.servedStorage.ref(
          session.storage,
          'pyric_oracle/run-1/listall-rules/allowed-dir/visible.bin',
        ),
        new Uint8Array([0x07]),
      );

      const captureAttempt = async (subpath: string): Promise<ListAttemptExpectation> => {
        try {
          const res = await session.servedStorage.listAll(
            session.servedStorage.ref(session.storage, subpath),
          );
          return {
            threw: false,
            code: null,
            isFirebaseError: false,
            itemNames: res.items.map((item) => item.name),
          };
        } catch (err) {
          let code: string | null = null;
          const rawCode = (err as { code?: unknown }).code;
          if (typeof rawCode === 'string') {
            code = rawCode;
          }
          return {
            threw: true,
            code,
            isFirebaseError: err instanceof FirebaseError,
            itemNames: [],
          };
        }
      };

      const allowedOutcome = await captureAttempt('pyric_oracle/run-1/listall-rules/allowed-dir');
      expect(allowedOutcome).toEqual(obs.authenticatedAllowed as ListAttemptExpectation);

      const outsideOutcome = await captureAttempt('pyric_oracle_denied_list/run-1/forbidden-dir');
      expect(outsideOutcome).toEqual(obs.authenticatedOutsideGrant as ListAttemptExpectation);

      await session.servedAuth.signOut(session.auth);
      const signedOutOutcome = await captureAttempt('pyric_oracle/run-1/listall-rules/allowed-dir');
      expect(signedOutOutcome).toEqual(obs.signedOutOnAuthRequiredPath as ListAttemptExpectation);
    } finally {
      await session.cleanup();
    }
  });
});
