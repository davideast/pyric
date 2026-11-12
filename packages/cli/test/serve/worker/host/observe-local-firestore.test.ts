import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { getFirestore } from 'pyric/firestore';
import { createObservedSessionDataStore } from '../../../../src/serve/observed-session/store.js';
import type { HostCtx } from '../../../../src/serve/worker/host.js';
import { firestoreVerdict } from '../../../../src/serve/worker/host/observe-local-firestore.js';
import { deployFirestoreRulesToHost } from '../../../../src/serve/worker/host/rules.js';

const OK = { status: 'ok' } as const;
const DENIED = { status: 'error', code: 'permission-denied' } as const;

describe('observe-local-firestore with observedSession (#2540)', () => {
  it('evaluates Firestore resource, get(), exists(), setDoc, and updateDoc against observedSession with partial/absent soundness', () => {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'fs-obs-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow read: if exists(/databases/$(database)/documents/admins/$(request.auth.uid))
        && get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.enabled == true;
      allow read: if request.auth != null && resource.data.owner == request.auth.uid;
      allow create: if request.auth != null
        && !exists(/databases/$(database)/documents/bans/$(request.auth.uid))
        && request.resource.data.owner == request.auth.uid;
      allow update: if request.auth != null
        && resource.data.owner == request.auth.uid
        && request.resource.data.owner == resource.data.owner
        && exists(/databases/$(database)/documents/users/$(request.auth.uid));
    }
  }
}`,
      ).ok,
    ).toBe(true);

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'items/item-1',
          at: 10,
          outcome: OK,
          account: { uid: 'u-1' },
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['admins/u-1', 'items/item-1'],
    });

    observedSession.apply({
      firestore: [{ kind: 'set', path: 'items/item-1', data: { owner: 'u-1', title: 'Initial' } }],
    });
    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'items/item-1',
          at: 11,
          outcome: OK,
          account: { uid: 'u-1' },
        },
        'get',
      ),
    ).toMatchObject({
      result: 'allow',
      rule: { line: 7 },
    });

    observedSession.apply({
      firestore: [{ kind: 'update', path: 'users/u-1', data: { nickname: 'Ada' } }],
    });
    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'updateDoc',
          path: 'items/item-1',
          writeData: { title: 'Renamed' },
          at: 12,
          outcome: OK,
          account: { uid: 'u-1' },
        },
        'update',
      ),
    ).toMatchObject({
      result: 'allow',
      rule: { line: 11 },
    });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'updateDoc',
          path: 'items/item-1',
          writeData: { owner: 'u-2' },
          at: 13,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'update',
      ),
    ).toMatchObject({
      result: 'deny',
    });

    observedSession.apply({
      firestore: [{ kind: 'set', path: 'admins/u-2', data: { note: 'partial' }, merge: true }],
    });
    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'items/item-1',
          at: 14,
          outcome: DENIED,
          account: { uid: 'u-2' },
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['admins/u-2'],
    });

    observedSession.apply({
      firestore: [
        { kind: 'delete', path: 'items/item-new' },
        { kind: 'delete', path: 'bans/u-1' },
      ],
    });
    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'setDoc',
          path: 'items/item-new',
          writeData: { owner: 'u-1', title: 'Fresh' },
          at: 15,
          outcome: OK,
          account: { uid: 'u-1' },
        },
        'set',
      ),
    ).toMatchObject({
      result: 'allow',
      rule: { line: 8 },
    });
  });

  it('abstains instead of failing open after sentinel updates (arrayRemove) or invalidated writes (#2540 F1, F4)', () => {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'fs-soundness-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /spaces/{s}/notes/{n} {
      allow read: if request.auth.uid in get(/databases/$(database)/documents/spaces/$(s)).data.members
        && !exists(/databases/$(database)/documents/bans/$(request.auth.uid));
    }
  }
}`,
      ).ok,
    ).toBe(true);

    observedSession.apply({
      firestore: [
        { kind: 'set', path: 'spaces/s1', data: { members: ['u-1', 'u-2'] } },
        { kind: 'delete', path: 'bans/u-2' },
      ],
    });
    // F4: updateDoc with `members: arrayRemove('u-2')` marks `spaces/s1` partial and deletes stale `members`.
    observedSession.apply({
      firestore: [
        {
          kind: 'update',
          path: 'spaces/s1',
          data: { updatedBy: 'u-1' },
          deleteFields: ['members'],
          partial: true,
        },
      ],
    });
    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'spaces/s1/notes/n1',
          at: 20,
          outcome: DENIED,
          account: { uid: 'u-2' },
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['spaces/s1'],
    });

    // F1: restore `spaces/s1`, then invalidate `bans/u-2` as a skipped/uncaptured write does.
    observedSession.apply({
      firestore: [{ kind: 'set', path: 'spaces/s1', data: { members: ['u-1', 'u-2'] } }],
    });
    observedSession.invalidateFirestore('bans/u-2');
    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDoc',
          path: 'spaces/s1/notes/n1',
          at: 21,
          outcome: DENIED,
          account: { uid: 'u-2' },
        },
        'get',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['bans/u-2'],
    });
  });

  it('abstains on Firestore invalidate ops from query removed docChanges and unconfirmed siblings while keeping confirmed siblings (#2540 N2, N4)', () => {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'fs-n2-n4-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tasks/{t} {
      allow update: if resource.data.status == 'open';
    }
  }
}`,
      ).ok,
    ).toBe(true);

    observedSession.apply({
      firestore: [
        { kind: 'set', path: 'tasks/t1', data: { status: 'open' } },
        { kind: 'set', path: 'tasks/t2', data: { status: 'open' } },
      ],
    });

    // N2: query listener `removed` docChange emits `{ kind: 'invalidate', path: 'tasks/t1' }`.
    // N4: mixed snapshot captures server-confirmed `tasks/t2` (`closed`) while invalidating `tasks/t3`.
    observedSession.apply({
      firestore: [
        { kind: 'invalidate', path: 'tasks/t1' },
        { kind: 'set', path: 'tasks/t2', data: { status: 'closed' } },
        { kind: 'invalidate', path: 'tasks/t3' },
      ],
    });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'updateDoc',
          path: 'tasks/t1',
          writeData: { note: 'x' },
          at: 30,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'update',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['tasks/t1'],
    });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'updateDoc',
          path: 'tasks/t2',
          writeData: { note: 'x' },
          at: 31,
          outcome: DENIED,
          account: { uid: 'u-1' },
        },
        'update',
      ),
    ).toMatchObject({
      result: 'deny',
    });
  });

  it('evaluates collection-group queries against path-invariant recursive rules rather than root collections', () => {
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'fs-collection-group-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
    };
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if true;
    }
    match /{path=**}/docs/{docId} {
      allow read: if docId != 'blocked';
    }
    match /{path=**}/notes/{id} {
      allow list: if request.auth != null;
    }
    match /{path=**}/posts/{id} {
      allow read: if resource.data.public == true;
    }
  }
}`,
      ).ok,
    ).toBe(true);

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDocs',
          path: 'items',
          query: { scope: 'collection-group' },
          at: 40,
          outcome: DENIED,
        },
        'list',
      ),
    ).toEqual({ result: 'deny' });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDocs',
          path: 'docs',
          query: { scope: 'collection-group' },
          at: 41,
          outcome: DENIED,
        },
        'list',
      ),
    ).toEqual({ result: 'deny' });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDocs',
          path: 'notes',
          query: { scope: 'collection-group' },
          at: 42,
          outcome: OK,
          account: { uid: 'u-1' },
        },
        'list',
      ),
    ).toMatchObject({ result: 'allow', rule: { line: 11 } });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDocs',
          path: 'notes',
          query: { scope: 'collection-group' },
          at: 43,
          outcome: DENIED,
        },
        'list',
      ),
    ).toMatchObject({ result: 'deny' });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDocs',
          path: 'posts',
          query: { scope: 'collection-group', filters: [{ field: 'public', op: '==' }] },
          at: 44,
          outcome: OK,
          account: { uid: 'u-1' },
        },
        'list',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
    });
  });

  it('tracks input gaps through helper parameters, let aliases, membership, bracket indexing, and Map.get', () => {
    const sandbox = initializeSandbox();
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'fs-helper-gaps-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
    };
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function hasAllowedEmail(auth) {
      let tok = auth.token;
      return tok.email == 'member@example.com';
    }
    function boundedPage(req) {
      return req.query.limit <= 25;
    }
    function keepsOwner(req) {
      return req.resource.data.ownerId == req.auth.uid;
    }
    match /users/{uid} {
      allow get: if request.auth != null && hasAllowedEmail(request.auth);
      allow delete: if request.auth != null && ('email' in request.auth.token) && request.auth.token['email'] == 'member@example.com';
    }
    match /profiles/{uid} {
      allow get: if request.auth != null && request.auth.token.get('email', '') == 'member@example.com';
      allow delete: if request.auth != null && ('email' in request.auth.token.firebase.identities || 'email' in request.auth.token.keys());
    }
    match /items/{id} {
      allow list: if boundedPage(request);
      allow update: if request.auth != null && keepsOwner(request);
      allow create: if request.auth != null
        && request.auth.token.get('role', 'viewer') == 'admin'
        && request.resource.data.get('visibility', 'private') == 'public';
    }
  }
}`,
      ).ok,
    ).toBe(true);

    const redactedEmailAccount = { uid: 'u-1', claimNames: ['email'], claims: {} };

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'getDoc', path: 'users/u-1', account: redactedEmailAccount, at: 50, outcome: OK },
        'get',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'deleteDoc', path: 'users/u-1', account: redactedEmailAccount, at: 51, outcome: OK },
        'delete',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        { service: 'firestore', method: 'getDoc', path: 'profiles/u-1', account: redactedEmailAccount, at: 52, outcome: OK },
        'get',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'deleteDoc',
          path: 'profiles/u-1',
          account: { uid: 'u-1', claimNames: ['email'], claims: { firebase: { identities: {} } } },
          at: 53,
          outcome: OK,
        },
        'delete',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['claim-values'] });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDocs',
          path: 'items',
          query: { scope: 'collection', limit: true },
          at: 54,
          outcome: OK,
        },
        'list',
      ),
    ).toMatchObject({ result: 'unevaluated', needs: ['query'] });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'updateDoc',
          path: 'items/item-1',
          account: { uid: 'u-1', claims: {} },
          writeData: { title: 'updated' },
          at: 55,
          outcome: OK,
        },
        'update',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: ['stored-document'],
      missingPaths: ['items/item-1'],
    });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'addDoc',
          path: 'items/item-2',
          account: { uid: 'u-1', claims: { role: 'admin' } },
          writeData: { visibility: 'public' },
          at: 56,
          outcome: OK,
        },
        'create',
      ),
    ).toMatchObject({ result: 'allow' });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'addDoc',
          path: 'items/item-3',
          account: { uid: 'u-1', claims: {} },
          writeData: { visibility: 'public' },
          at: 57,
          outcome: DENIED,
        },
        'create',
      ),
    ).toMatchObject({ result: 'deny' });
  });

  it('denies unprovable unconstrained collection list queries without leaking __hypothetical_doc__ and abstains when filters could discharge predicates', () => {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'fs-collection-list-proof-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow read: if id != 'blocked';
    }
    match /docs/{docId} {
      allow read: if request.path[4] != 'blocked';
    }
    match /orgs/{orgId} {
      allow read: if exists(/databases/$(database)/documents/teams/$(orgId));
    }
    match /publicItems/{id} {
      allow read: if true;
    }
    match /ownedItems/{id} {
      allow read: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
  }
}`,
      ).ok,
    ).toBe(true);

    const itemsVerdict = firestoreVerdict(
      ctx,
      {
        service: 'firestore',
        method: 'getDocs',
        path: 'items',
        query: { scope: 'collection' },
        at: 60,
        outcome: DENIED,
      },
      'list',
    );
    expect(itemsVerdict).toMatchObject({ result: 'deny' });

    const docsVerdict = firestoreVerdict(
      ctx,
      {
        service: 'firestore',
        method: 'getDocs',
        path: 'docs',
        query: { scope: 'collection' },
        at: 61,
        outcome: DENIED,
      },
      'list',
    );
    expect(docsVerdict).toMatchObject({ result: 'deny' });

    const orgsVerdict = firestoreVerdict(
      ctx,
      {
        service: 'firestore',
        method: 'getDocs',
        path: 'orgs',
        query: { scope: 'collection' },
        at: 62,
        outcome: DENIED,
      },
      'list',
    );
    expect(orgsVerdict).toMatchObject({ result: 'deny' });
    expect(orgsVerdict?.missingPaths ?? []).toEqual([]);

    const publicVerdict = firestoreVerdict(
      ctx,
      {
        service: 'firestore',
        method: 'getDocs',
        path: 'publicItems',
        query: { scope: 'collection' },
        at: 63,
        outcome: OK,
      },
      'list',
    );
    expect(publicVerdict).toMatchObject({ result: 'allow' });

    const filteredVerdict = firestoreVerdict(
      ctx,
      {
        service: 'firestore',
        method: 'getDocs',
        path: 'ownedItems',
        query: { scope: 'collection', filters: [{ field: 'ownerId', op: '==' }] },
        account: { uid: 'u-1' },
        at: 64,
        outcome: OK,
      },
      'list',
    );
    expect(filteredVerdict).toMatchObject({
      result: 'unevaluated',
      needs: expect.arrayContaining(['query']),
    });
  });

  it('tracks input gaps through ternary conditional receivers on both branches', () => {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'fs-ternary-gaps-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if (request.auth != null ? request : request).query.limit <= 10;
      allow update: if (request.auth != null ? request : request).resource.data.ownerId == request.auth.uid;
    }
    match /docs/{docId} {
      allow list: if (request.auth == null ? resource : request).query.limit == null;
    }
  }
}`,
      ).ok,
    ).toBe(true);

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDocs',
          path: 'items',
          query: { scope: 'collection', limit: true },
          account: { uid: 'u-1', claimNames: ['sub'], claims: { sub: 'u-1' } },
          at: 70,
          outcome: OK,
        },
        'list',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: expect.arrayContaining(['query']),
    });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'updateDoc',
          path: 'items/item-1',
          writeData: { title: 'updated' },
          account: { uid: 'u-1', claimNames: ['sub'], claims: { sub: 'u-1' } },
          at: 71,
          outcome: OK,
        },
        'update',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: expect.arrayContaining(['stored-document']),
      missingPaths: ['items/item-1'],
    });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'getDocs',
          path: 'docs',
          query: { scope: 'collection', limit: true },
          account: { uid: 'u-1', claimNames: ['sub'], claims: { sub: 'u-1' } },
          at: 72,
          outcome: DENIED,
        },
        'list',
      ),
    ).toMatchObject({
      result: 'unevaluated',
      needs: expect.arrayContaining(['query']),
    });
  });

  it('rehydrates session-observed Timestamp, GeoPoint, Bytes, VectorValue, DocumentReference, escaped maps, and IEEE-754 floats in resource and get()', () => {
    const sandbox = initializeSandbox();
    const observedSession = createObservedSessionDataStore({ projectId: 'demo-project' });
    const ctx: HostCtx = {
      db: getFirestore(sandbox),
      sandbox,
      instanceId: 'fs-typed-session-test',
      subs: new Map(),
      rtdbProjectId: 'demo-project',
      observedSession,
    };
    expect(
      deployFirestoreRulesToHost(
        ctx,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow delete: if resource.data.ts is timestamp
                    && resource.data.loc is latlng
                    && resource.data.bin is bytes
                    && !(resource.data.vec is map)
                    && resource.data.ref is path
                    && resource.data.plainTs.seconds == 5
                    && resource.data.plainGeo.latitude == 12.5
                    && resource.data.plainVec is map
                    && resource.data.plainVec.__type__ == '__vector__'
                    && resource.data.plainRef.type == 'document'
                    && resource.data.plainNum.type == 'pyric/number/1.0'
                    && get(/databases/$(database)/documents/docs/doc-num).data.negZero is float
                    && !(get(/databases/$(database)/documents/docs/doc-num).data.negZero is int);
    }
    match /docs/{docId} {
      allow delete: if resource.data.negZero is float
                    && !(resource.data.negZero is int)
                    && resource.data.posInf is float
                    && resource.data.negInf is float
                    && resource.data.nanVal is float;
    }
    match /notes/{noteId} {
      allow delete: if resource.data.title == 'v2';
    }
  }
}`,
      ).ok,
    ).toBe(true);

    observedSession.apply({
      firestore: [
        {
          kind: 'set',
          path: 'items/item-1',
          data: {
            ts: { seconds: 1_700_000_000, nanoseconds: 0 },
            loc: { latitude: 37.7, longitude: -122.4 },
            bin: { type: 'firestore/bytes/1.0', bytes: 'AQID' },
            vec: { __type__: '__vector__', value: [0.5, 1.5] },
            ref: { type: 'document', path: 'users/u-1', id: 'u-1' },
            plainTs: { type: 'pyric/map/1.0', fields: { seconds: 5, nanoseconds: 0 } },
            plainGeo: { type: 'pyric/map/1.0', fields: { latitude: 12.5, longitude: 42.25 } },
            plainVec: { type: 'pyric/map/1.0', fields: { __type__: '__vector__', value: [0.5, 1.5] } },
            plainRef: {
              type: 'pyric/map/1.0',
              fields: { type: 'document', path: 'users/u-1', id: 'u-1' },
            },
            plainNum: {
              type: 'pyric/map/1.0',
              fields: { type: 'pyric/number/1.0', value: '-0' },
            },
          },
        },
        {
          kind: 'set',
          path: 'docs/doc-num',
          data: {
            negZero: { type: 'pyric/number/1.0', value: '-0' },
            posInf: { type: 'pyric/number/1.0', value: 'Infinity' },
            negInf: { type: 'pyric/number/1.0', value: '-Infinity' },
            nanVal: { type: 'pyric/number/1.0', value: 'NaN' },
          },
        },
        { kind: 'delete', path: 'notes/note-absent' },
        {
          kind: 'update',
          path: 'notes/note-absent',
          data: { title: 'v2' },
          merge: true,
        },
      ],
    });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'deleteDoc',
          path: 'items/item-1',
          at: 80,
          outcome: OK,
        },
        'delete',
      ),
    ).toMatchObject({ result: 'allow' });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'deleteDoc',
          path: 'docs/doc-num',
          at: 81,
          outcome: OK,
        },
        'delete',
      ),
    ).toMatchObject({ result: 'allow' });

    expect(
      firestoreVerdict(
        ctx,
        {
          service: 'firestore',
          method: 'deleteDoc',
          path: 'notes/note-absent',
          at: 82,
          outcome: OK,
        },
        'delete',
      ),
    ).toMatchObject({ result: 'allow' });
  });
});
