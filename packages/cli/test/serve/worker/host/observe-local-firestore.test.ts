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
});
