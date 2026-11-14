import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { getFirestore } from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { createObservedSessionDataStore } from '../../../../src/serve/observed-session/store.js';
import type { HostCtx } from '../../../../src/serve/worker/host.js';
import { firestoreVerdict } from '../../../../src/serve/worker/host/observe-local-firestore.js';
import { deployFirestoreRulesToHost } from '../../../../src/serve/worker/host/rules.js';

const OK = { status: 'ok' } as const;
const DENIED = { status: 'error', code: 'permission-denied' } as const;

function makeHost(): { ctx: HostCtx; observedSession: ReturnType<typeof createObservedSessionDataStore> } {
  const sandbox = initializeSandbox();
  const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
  const ctx: HostCtx = {
    db: getFirestore(sandbox),
    sandbox,
    instanceId: 'fs-colliding-maps-test',
    subs: new Map(),
    rtdbProjectId: 'demo-project',
    observedSession,
  };
  return { ctx, observedSession };
}

describe('observe-local-firestore colliding user maps', () => {
  it('evaluates all 6 colliding marker shapes in writeData and returned document as plain maps rather than wrapper types', () => {
    const { ctx } = makeHost();
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow create: if request.resource.data.tsMap is timestamp
                    || request.resource.data.bytesMap is bytes
                    || request.resource.data.geoMap is latlng
                    || request.resource.data.durMap is duration
                    || request.resource.data.refMap is path
                    || !(request.resource.data.vecMap is map)
                    || request.resource.data.sentinelMap is timestamp
                    || !(request.resource.data.typeNameMap is map)
                    || request.resource.data.idPathMap is path;
      allow get: if resource.data.meta is map
                 && !(resource.data.meta is timestamp)
                 && resource.data.meta.__type == 'timestamp'
                 && resource.data.env is map
                 && resource.data.env.type == 'pyric/map/1.0'
                 && resource.data.env.fields.label == 'kept';
    }
  }
}`,
      ).ok,
    ).toBe(true);

    const escapedPayload = {
      tsMap: { type: 'pyric/map/1.0', fields: { __type: 'timestamp', seconds: 100, nanos: 0 } },
      bytesMap: { type: 'pyric/map/1.0', fields: { __type: 'bytes', base64: 'AQID' } },
      geoMap: { type: 'pyric/map/1.0', fields: { __type: 'latlng', lat: 10, lng: 20 } },
      durMap: { type: 'pyric/map/1.0', fields: { __type: 'duration', seconds: 5, nanos: 0 } },
      refMap: { type: 'pyric/map/1.0', fields: { type: 'document', id: 'u-1', path: 'users/u-1' } },
      vecMap: { type: 'pyric/map/1.0', fields: { __type__: '__vector__', value: [1, 2] } },
      sentinelMap: { type: 'pyric/map/1.0', fields: { _methodName: 'serverTimestamp' } },
      typeNameMap: { type: 'pyric/map/1.0', fields: { typeName: 'timestamp', seconds: 1 } },
      idPathMap: { type: 'pyric/map/1.0', fields: { id: 'u-1', path: 'users/u-1' } },
    };

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'setDoc',
          path: 'items/item-escaped',
          at: 100,
          outcome: DENIED,
          writeData: escapedPayload,
        },
        'create',
      ),
    ).toMatchObject({ result: 'deny' });

    const rawUnescapedPayload = {
      tsMap: { __type: 'timestamp', seconds: 100, nanos: 0 },
      bytesMap: { __type: 'bytes', base64: 'AQID' },
      geoMap: { __type: 'latlng', lat: 10, lng: 20 },
      durMap: { __type: 'duration', seconds: 5, nanos: 0 },
      refMap: { type: 'document', id: 'u-1', path: 'users/u-1' },
      vecMap: { __type__: '__vector__', value: [1, 2] },
      sentinelMap: { _methodName: 'serverTimestamp' },
      typeNameMap: { typeName: 'timestamp', seconds: 1 },
      idPathMap: { id: 'u-1', path: 'users/u-1' },
    };

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'setDoc',
          path: 'items/item-raw',
          at: 101,
          outcome: DENIED,
          writeData: rawUnescapedPayload,
        },
        'create',
      ),
    ).toMatchObject({ result: 'deny' });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'items/item-read',
          at: 102,
          outcome: OK,
          document: {
            meta: { type: 'pyric/map/1.0', fields: { __type: 'timestamp', seconds: 100, nanos: 0 } },
            env: {
              type: 'pyric/map/1.0',
              fields: { type: 'pyric/map/1.0', fields: { label: 'kept' } },
            },
          },
        },
        'get',
      ),
    ).toMatchObject({ result: 'allow' });
  });

  it('keeps colliding user maps escaped across dotted session updates, merges, and updateDoc after-state projection', () => {
    const { ctx, observedSession } = makeHost();
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /docs/{docId} {
      allow delete: if resource.data.meta is timestamp
                    || resource.data.sentinel is timestamp
                    || resource.data.link is path;
      allow update: if request.resource.data.sentinel is timestamp
                    || request.resource.data.rawBytes is bytes;
    }
  }
}`,
      ).ok,
    ).toBe(true);

    observedSession.apply({
      firestore: [
        {
          kind: 'set',
          path: 'docs/doc-1',
          data: {
            meta: { type: 'pyric/map/1.0', fields: { __type: 'timestamp', seconds: 100 } },
            sentinel: { label: 'plain' },
            link: { id: 'u-1' },
            rawBytes: { type: 'pyric/map/1.0', fields: { __type: 'bytes' } },
          },
        },
        {
          kind: 'update',
          path: 'docs/doc-1',
          data: {
            'meta.nanos': 0,
            'sentinel._methodName': 'serverTimestamp',
          },
        },
        {
          kind: 'set',
          path: 'docs/doc-1',
          merge: true,
          data: {
            link: { path: 'users/u-1', type: 'document' },
          },
        },
      ],
    });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'deleteDoc',
          path: 'docs/doc-1',
          at: 110,
          outcome: DENIED,
        },
        'delete',
      ),
    ).toMatchObject({ result: 'deny' });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'updateDoc',
          path: 'docs/doc-1',
          at: 111,
          outcome: DENIED,
          writeData: {
            'sentinel._methodName': 'serverTimestamp',
            'rawBytes.base64': 'AQID',
          },
        },
        'update',
      ),
    ).toMatchObject({ result: 'deny' });
  });
});
