/**
 * Served-entry + SharedWorker conformance for `ref()` (`storage#13..23`):
 *   - `client-storage-ref-root-and-segments` (`storage#13, #14, #21`)
 *   - `client-storage-ref-slash-normalization` (`storage#15, #16, #17`)
 *   - `client-storage-ref-hierarchy-and-traversal` (`storage#18, #19, #20`)
 *   - `client-storage-ref-identity-and-storage-handle` (`storage#22, #23`)
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { deleteApp } from 'pyric/app';
import { createAppForSandbox } from 'pyric/app/internal';
import { handleMessage, type PortLike } from '../../../src/serve/worker/host.js';
import type { InboundMessage, OutboundMessage } from '../../../src/serve/worker/protocol.js';
import type { ClientStorageReference } from '../../../src/serve/worker/client/storage.js';
import { type FakePort, makeHostCtx, portPair } from './integration-support.js';

interface RefSnapshotExpectation {
  fullPath: string;
  name: string;
  hasParent: boolean;
  parentFullPath: string | null;
  rootFullPath: string;
}

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

function assertMatchesSnapshot(
  actual: ClientStorageReference,
  expected: RefSnapshotExpectation,
): void {
  expect(actual.fullPath).toBe(expected.fullPath);
  expect(actual.name).toBe(expected.name);
  expect(actual.parent !== null).toBe(expected.hasParent);
  if (actual.parent === null) {
    expect(expected.parentFullPath).toBeNull();
  } else {
    expect(actual.parent.fullPath).toBe(expected.parentFullPath as string);
  }
  expect(actual.root.fullPath).toBe(expected.rootFullPath);
  expect(actual.toString()).toBe(`gs://${actual.bucket}/${expected.fullPath}`);
}

let appSeq = 0;

describe('served entry + SharedWorker ref() parity (storage#13..23)', () => {
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
    let storageOpMessages = 0;

    (globalThis as { SharedWorker?: unknown }).SharedWorker = class {
      port: FakePort;
      addEventListener() {}
      constructor(_url: unknown, _opts: unknown) {
        const { a: clientPort, b: hostPort } = portPair();
        const hostPortLike: PortLike = {
          postMessage: (message: OutboundMessage) => hostPort.postMessage(message),
        };
        hostPort.onmessage = (event) => {
          const inbound = event.data as InboundMessage;
          if (inbound.t === 'op' && inbound.method.startsWith('storage.')) {
            storageOpMessages += 1;
          }
          void handleMessage(ctx, hostPortLike, inbound);
        };
        this.port = clientPort;
      }
    };

    const served = await import('../../../src/serve/entries/storage.js');
    const app = createAppForSandbox(
      ctx.sandbox,
      { projectId: 'demo-storage', storageBucket: 'buckets-default' },
      `served-ref-props-${++appSeq}`,
    );
    const storage = served.getStorage(app);

    return {
      served,
      storage,
      getStorageOpCount: () => storageOpMessages,
      cleanup: async () => {
        await deleteApp(app);
        ctx.sandbox.dispose();
      },
    };
  }

  test('storage#13..23: replays root/segments, slash normalization, hierarchy/empty-child join, and value-object identity with zero RPCs', async () => {
    const rootObs = loadBehavior('client-storage-ref-root-and-segments');
    const slashObs = loadBehavior('client-storage-ref-slash-normalization');
    const hierObs = loadBehavior('client-storage-ref-hierarchy-and-traversal');
    const idObs = loadBehavior('client-storage-ref-identity-and-storage-handle');

    const session = await setupServedStorage();
    try {
      const opsBefore = session.getStorageOpCount();
      const s = session.storage;
      const makeRef = session.served.ref;

      const bareExpected = rootObs.bareRoot as RefSnapshotExpectation & {
        rootStrictEqualSelf: boolean;
        rootToStringMatchesSelf: boolean;
      };
      const bareRoot = makeRef(s);
      assertMatchesSnapshot(bareRoot, bareExpected);
      expect(bareRoot.root === bareRoot).toBe(bareExpected.rootStrictEqualSelf);
      expect(bareRoot.root.toString() === bareRoot.toString()).toBe(
        bareExpected.rootToStringMatchesSelf,
      );
      assertMatchesSnapshot(makeRef(s, ''), rootObs.emptyStringRoot as RefSnapshotExpectation);
      assertMatchesSnapshot(
        makeRef(s, 'readme.txt'),
        rootObs.singleSegment as RefSnapshotExpectation,
      );
      assertMatchesSnapshot(
        makeRef(s, 'sessions/s1.json'),
        rootObs.nestedSegments as RefSnapshotExpectation,
      );
      assertMatchesSnapshot(
        makeRef(s, 'orgs/acme/projects/p1/report.csv'),
        rootObs.deepSegments as RefSnapshotExpectation,
      );

      assertMatchesSnapshot(
        makeRef(s, '/sessions/s1'),
        slashObs.singleLeadingSlash as RefSnapshotExpectation,
      );
      assertMatchesSnapshot(
        makeRef(s, 'sessions/s1///'),
        slashObs.multipleTrailingSlashes as RefSnapshotExpectation,
      );
      assertMatchesSnapshot(
        makeRef(s, '///a//b/c///'),
        slashObs.combinedSlashes as RefSnapshotExpectation,
      );
      assertMatchesSnapshot(makeRef(s, '////'), slashObs.onlySlashes as RefSnapshotExpectation);

      const folderRef = makeRef(s, 'users/u1');
      assertMatchesSnapshot(
        makeRef(bareRoot, 'items/doc.txt'),
        hierObs.childFromRoot as RefSnapshotExpectation,
      );
      assertMatchesSnapshot(
        makeRef(folderRef, 'avatars/profile.png'),
        hierObs.childFromFolder as RefSnapshotExpectation,
      );
      assertMatchesSnapshot(
        makeRef(makeRef(s, '/users//u1/'), '//avatars//banner.png/'),
        hierObs.slashyChildJoin as RefSnapshotExpectation,
      );
      assertMatchesSnapshot(makeRef(folderRef, ''), hierObs.emptyChildJoin as RefSnapshotExpectation);
      assertMatchesSnapshot(
        makeRef(folderRef, '///'),
        hierObs.slashOnlyChildJoin as RefSnapshotExpectation,
      );

      const steps: Array<{ fullPath: string; name: string }> = [];
      let cursor: ClientStorageReference | null = makeRef(s, 'alpha/beta/gamma');
      while (cursor !== null) {
        steps.push({ fullPath: cursor.fullPath, name: cursor.name });
        cursor = cursor.parent;
      }
      expect(steps).toEqual(
        hierObs.parentChainFromDepth3 as Array<{ fullPath: string; name: string }>,
      );

      const firstSame = makeRef(s, 'a/b');
      const secondSame = makeRef(s, 'a/b');
      const firstParent = firstSame.parent;
      const secondParent = firstSame.parent;
      expect(firstParent).not.toBeNull();
      expect(secondParent).not.toBeNull();
      if (firstParent !== null && secondParent !== null) {
        const childFromParent = makeRef(firstParent, 'b');
        expect(firstSame === secondSame).toBe(idObs.samePathStrictEqual as boolean);
        expect(firstParent === secondParent).toBe(idObs.repeatedParentGetterStrictEqual as boolean);
        expect(firstSame.root === firstSame.root).toBe(
          idObs.repeatedRootGetterStrictEqual as boolean,
        );
        expect(firstSame.storage === s).toBe(idObs.directPreservesStorageHandle as boolean);
        expect(firstParent.storage === s).toBe(idObs.parentPreservesStorageHandle as boolean);
        expect(firstSame.root.storage === s).toBe(idObs.rootPreservesStorageHandle as boolean);
        expect(childFromParent.storage === s).toBe(idObs.childJoinPreservesStorageHandle as boolean);
      }

      expect(session.getStorageOpCount() - opsBefore).toBe(0);
    } finally {
      await session.cleanup();
    }
  });
});
