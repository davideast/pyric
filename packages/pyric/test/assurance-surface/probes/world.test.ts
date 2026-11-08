import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { getAuth, sandbox as authSandbox } from 'pyric/auth';
import {
  getAdminDatabase,
  ref as rtdbRef,
  sandbox as rtdbSandbox,
  setWithPriority,
} from 'pyric/database';
import {
  Bytes,
  Timestamp,
  doc,
  getAdminFirestore,
  setDoc,
} from 'pyric/firestore';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules as setFirestoreRules } from 'pyric/sandbox/firestore';
import { captureSandboxSnapshot } from 'pyric/sandbox/internal';
import {
  getBytes as getStorageBytes,
  getStorageSandbox,
  ref as storageRef,
  uploadBytes,
} from 'pyric/storage';
import { getAdminStorageSandbox } from 'pyric/storage/internal';
import { runProbes } from '../../../src/assurance-surface/probes/run-probes.js';
import type { ProbeActor } from '../../../src/assurance-surface/probes/types.js';
import { ProbeWorld } from '../../../src/assurance-surface/probes/world.js';
import { ownerConditionsFrom } from '../../../src/assurance-surface/rules/analyze-owners.js';
import { inferOwnerBindings } from '../../../src/assurance-surface/rules/cross-check.js';

let nextWorldTestDb = 1;
function uniqueTestStorageDb(): string {
  return `pyric-probe-world-test:${nextWorldTestDb++}`;
}

const ACTORS: ProbeActor[] = [
  { role: 'owner', uid: 'u-owner', email: 'owner@probe.local', displayName: 'Owner', token: {} },
  { role: 'peer', uid: 'u-peer', email: 'peer@probe.local', displayName: 'Peer', token: {} },
];

const MEMBERSHIP_FIRESTORE_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/settings/{docId} {
      allow read: if exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid));
    }
    match /orgs/{orgId}/notes/{noteId} {
      allow read, create: if exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid));
      allow delete: if exists(/databases/$(database)/documents/orgs/$(orgId)/members/$(request.auth.uid))
        && resource.data.authorId == request.auth.uid;
    }
  }
}`;

describe('ProbeWorld', () => {
  test('preserves initial Firestore state and prior admin steps across sequential admin seeds', async () => {
    const world = new ProbeWorld(
      { firestore: MEMBERSHIP_FIRESTORE_RULES },
      ACTORS,
      {
        firestore: {
          'orgs/org-1/settings/general': { plan: 'team' },
        },
      },
    );

    try {
      const seedOwner = await world.run({
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/org-1/members/u-owner',
        data: { active: true },
      });
      const seedPeer = await world.run({
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/org-1/members/u-peer',
        data: { active: true },
      });
      expect(seedOwner.decision).toBe('allow');
      expect(seedPeer.decision).toBe('allow');

      // Both actors' membership records AND the initial settings doc must still exist.
      const ownerReadsSettings = await world.run({
        actor: 'owner',
        service: 'firestore',
        method: 'get',
        path: 'orgs/org-1/settings/general',
      });
      const ownerCreatesNote = await world.run({
        actor: 'owner',
        service: 'firestore',
        method: 'set',
        path: 'orgs/org-1/notes/n1',
        data: { authorId: 'u-owner', body: 'hello' },
      });
      const peerReadsNote = await world.run({
        actor: 'peer',
        service: 'firestore',
        method: 'get',
        path: 'orgs/org-1/notes/n1',
      });
      const peerDeletesOwnerNote = await world.run({
        actor: 'peer',
        service: 'firestore',
        method: 'delete',
        path: 'orgs/org-1/notes/n1',
      });

      expect(ownerReadsSettings.decision).toBe('allow');
      expect(ownerCreatesNote.decision).toBe('allow');
      expect(peerReadsNote.decision).toBe('allow');
      expect(peerDeletesOwnerNote.decision).toBe('deny');
    } finally {
      world.dispose();
    }
  });

  test('evaluates Realtime Database writes against actor identities and sentinel values', async () => {
    const world = new ProbeWorld(
      {
        rtdb: {
          rules: {
            items: {
              $itemId: {
                '.read': 'auth != null',
                '.write': '!data.exists() ? newData.child("owner").val() === auth.uid : data.child("owner").val() === auth.uid',
              },
            },
          },
        },
      },
      ACTORS,
    );

    try {
      const createByOwner = await world.run({
        actor: 'owner',
        service: 'rtdb',
        method: 'set',
        path: 'items/item-1',
        data: { owner: 'u-owner', createdAt: { __sentinel: 'serverTimestamp' } },
      });
      const deleteByPeer = await world.run({
        actor: 'peer',
        service: 'rtdb',
        method: 'remove',
        path: 'items/item-1',
      });
      expect(createByOwner.decision).toBe('allow');
      expect(deleteByPeer.decision).toBe('deny');
    } finally {
      world.dispose();
    }
  });

  test('restores a full multi-service SandboxSnapshot with rich Firestore types, RTDB priorities, Storage objects, and Auth claims in an isolated world', async () => {
    const source = initializeSandbox();
    try {
      setFirestoreRules(
        source,
        `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orgs/{orgId}/members/{uid} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
    match /items/{id} {
      allow read, update: if request.auth != null
        && request.auth.token.tier == 'pro'
        && resource.data.ownerId == request.auth.uid
        && resource.data.expiresAt is timestamp
        && resource.data.digest is bytes;
      allow delete: if request.auth != null && resource.data.ownerId == request.auth.uid;
    }
  }
}`,
      );
      const sourceFs = getAdminFirestore(source);
      await setDoc(doc(sourceFs, 'items/item-1'), {
        ownerId: 'u-owner',
        expiresAt: Timestamp.fromMillis(1_700_000_500_000),
        digest: Bytes.fromUint8Array(new Uint8Array([1, 2, 3, 250])),
      });

      const sourceRtdb = getAdminDatabase(source);
      rtdbSandbox.setRules(sourceRtdb, {
        rules: {
          items: {
            $id: {
              '.read': 'auth != null && data.getPriority() === 10',
              '.write':
                'auth != null && data.getPriority() === 10 && data.child("owner").val() === auth.uid',
            },
          },
          audit: {
            $id: {
              '.read': 'auth != null',
              '.write': false,
            },
          },
        },
      });
      await setWithPriority(
        rtdbRef(sourceRtdb, 'items/item-1'),
        { owner: 'u-owner', label: 'pinned' },
        10,
      );

      const sourceStorage = getAdminStorageSandbox(source, {
        dbName: uniqueTestStorageDb(),
        rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow read: if request.auth != null
        && request.auth.uid == uid
        && resource.metadata.tier == 'pro';
      allow write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`,
      });
      await uploadBytes(
        storageRef(sourceStorage, 'files/u-owner/report.txt'),
        new TextEncoder().encode('confidential payload'),
        {
          contentType: 'text/plain',
          customMetadata: { tier: 'pro' },
        },
      );

      authSandbox.seedUsers(getAuth(source), [
        {
          uid: 'u-owner',
          email: 'owner@probe.local',
          displayName: 'Owner',
          customClaims: { tier: 'pro' },
        },
        {
          uid: 'u-peer',
          email: 'peer@probe.local',
          displayName: 'Peer',
          customClaims: { tier: 'free' },
        },
      ]);

      const rawSnapshot = await captureSandboxSnapshot(source);
      const snapshot = JSON.parse(JSON.stringify(rawSnapshot));

      const world = new ProbeWorld({}, ACTORS, { snapshot });
      try {
        // Admin Firestore seed must preserve rich Timestamp/Bytes wrappers on items/item-1.
        const adminFsSeed = await world.run({
          actor: 'admin',
          service: 'firestore',
          method: 'set',
          path: 'orgs/acme/members/u-owner',
          data: { active: true },
        });
        expect(adminFsSeed.decision).toBe('allow');

        const ownerFsRead = await world.run({
          actor: 'owner',
          service: 'firestore',
          method: 'get',
          path: 'items/item-1',
        });
        const peerFsDelete = await world.run({
          actor: 'peer',
          service: 'firestore',
          method: 'delete',
          path: 'items/item-1',
        });
        expect(ownerFsRead.decision).toBe('allow');
        expect(peerFsDelete.decision).toBe('deny');

        // RTDB admin write + owner/peer probes against restored .priority wrapper.
        const adminRtdbSeed = await world.run({
          actor: 'admin',
          service: 'rtdb',
          method: 'set',
          path: 'audit/e1',
          data: { ok: true },
        });
        const ownerRtdbRead = await world.run({
          actor: 'owner',
          service: 'rtdb',
          method: 'get',
          path: 'items/item-1',
        });
        const peerRtdbDelete = await world.run({
          actor: 'peer',
          service: 'rtdb',
          method: 'remove',
          path: 'items/item-1',
        });
        const ownerRtdbDelete = await world.run({
          actor: 'owner',
          service: 'rtdb',
          method: 'remove',
          path: 'items/item-1',
        });
        expect(adminRtdbSeed.decision).toBe('allow');
        expect(ownerRtdbRead.decision).toBe('allow');
        expect(peerRtdbDelete.decision).toBe('deny');
        expect(ownerRtdbDelete.decision).toBe('allow');

        // Storage owner/peer probes and isolation from source sandbox.
        const ownerStorageRead = await world.run({
          actor: 'owner',
          service: 'storage',
          method: 'get',
          path: 'files/u-owner/report.txt',
        });
        const peerStorageRead = await world.run({
          actor: 'peer',
          service: 'storage',
          method: 'get',
          path: 'files/u-owner/report.txt',
        });
        const peerStorageDelete = await world.run({
          actor: 'peer',
          service: 'storage',
          method: 'delete',
          path: 'files/u-owner/report.txt',
        });
        const ownerStorageDelete = await world.run({
          actor: 'owner',
          service: 'storage',
          method: 'delete',
          path: 'files/u-owner/report.txt',
        });
        expect(ownerStorageRead.decision).toBe('allow');
        expect(peerStorageRead.decision).toBe('deny');
        expect(peerStorageDelete.decision).toBe('deny');
        expect(ownerStorageDelete.decision).toBe('allow');

        // Source sandbox Storage object must still exist untouched.
        const sourceBytes = await getStorageBytes(
          storageRef(sourceStorage, 'files/u-owner/report.txt'),
        );
        expect(new TextDecoder().decode(sourceBytes)).toBe('confidential payload');
      } finally {
        world.dispose();
      }
    } finally {
      source.dispose();
    }
  });

  test('surfaces rule restoration refusals cleanly via ProbeWorld.create and ProbeWorld.run', async () => {
    await expect(
      ProbeWorld.create({ firestore: 'rules_version = "2"; invalid {' }, ACTORS),
    ).rejects.toThrow();

    const world = new ProbeWorld({ firestore: 'rules_version = "2"; invalid {' }, ACTORS);
    try {
      const result = await world.run({
        actor: 'owner',
        service: 'firestore',
        method: 'get',
        path: 'items/item-1',
      });
      expect(result.decision).toBe('error');
      expect(result.message).toBeTruthy();
    } finally {
      world.dispose();
    }
  });

  test('runProbes derives seed records and users directly from WorldState.snapshot', async () => {
    const source = initializeSandbox();
    try {
      const firestoreRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{itemId} {
      allow read, create: if request.auth != null && request.resource.data.ownerId == request.auth.uid;
      allow update, delete: if request.auth != null;
    }
  }
}`;
      setFirestoreRules(source, firestoreRules);
      const sourceFs = getAdminFirestore(source);
      await setDoc(doc(sourceFs, 'items/item-a'), { ownerId: 'u-alice', label: 'A' });
      await setDoc(doc(sourceFs, 'items/item-b'), { ownerId: 'u-bob', label: 'B' });
      authSandbox.seedUsers(getAuth(source), [
        { uid: 'u-alice', email: 'alice@probe.local', displayName: 'Alice' },
        { uid: 'u-bob', email: 'bob@probe.local', displayName: 'Bob' },
      ]);

      const snapshot = await captureSandboxSnapshot(source);
      const sources = {
        firestore: [{ source: 'firestore.rules', text: firestoreRules }],
        rtdb: [],
        problems: [],
      };
      const conditions = ownerConditionsFrom(sources);
      const bindings = inferOwnerBindings(conditions, []);
      const report = await runProbes({
        accessSites: [],
        ownerBindings: bindings,
        conditions,
        sources,
        state: { snapshot },
      });

      expect(report.actors.map((a) => a.uid).sort()).toEqual(['u-alice', 'u-bob']);
      expect(report.findings.some((f) => f.path === 'items/{itemId}' && f.kind === 'foreign-delete')).toBe(
        true,
      );
    } finally {
      source.dispose();
    }
  });

  test('isolates Storage backing store when snapshot has named-bucket rules and an empty default bucket', async () => {
    const live = initializeSandbox();
    try {
      const liveStorage = getStorageSandbox(live.withAuth({ uid: 'u-owner' }), {
        rules: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}`,
      });
      await uploadBytes(
        storageRef(liveStorage, 'files/u-owner/keep.txt'),
        new TextEncoder().encode('live default bytes'),
      );

      const snapshot = {
        version: 1 as const,
        rules: {
          storage: {
            'media-bucket': `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read: if request.auth != null;
    }
  }
}`,
          },
        },
        auth: { users: [] },
        firestore: { '(default)': {} },
        rtdb: {},
        storage: { '(default)': [] },
      };

      const world = await ProbeWorld.create({}, ACTORS, { snapshot });
      world.dispose();

      const surviving = await getStorageBytes(
        storageRef(liveStorage, 'files/u-owner/keep.txt'),
      );
      expect(new TextDecoder().decode(surviving)).toBe('live default bytes');
    } finally {
      live.dispose();
    }
  });

  test('classifies allowed Storage get on unseeded paths as allow and unauthorized get as deny', async () => {
    const world = new ProbeWorld(
      {
        storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /files/{uid}/{name} {
      allow read: if request.auth != null && request.auth.uid == uid;
    }
  }
}`,
      },
      ACTORS,
    );

    try {
      const ownerGetUnseeded = await world.run({
        actor: 'owner', service: 'storage', method: 'get', path: 'files/u-owner/unseeded.txt',
      });
      const peerGetUnseeded = await world.run({
        actor: 'peer', service: 'storage', method: 'get', path: 'files/u-owner/unseeded.txt',
      });
      expect(ownerGetUnseeded.decision).toBe('allow');
      expect(peerGetUnseeded.decision).toBe('deny');
    } finally {
      world.dispose();
    }
  });

  test('preserves rich Firestore instances in ProbeStep.data and encodes marker-shaped plain user maps losslessly', async () => {
    const world = new ProbeWorld(
      {
        firestore: `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow create, update: if request.auth != null
        && request.resource.data.createdAt is timestamp
        && request.resource.data.digest is bytes;
      allow read: if request.auth != null
        && resource.data.createdAt is timestamp
        && resource.data.digest is bytes
        && resource.data.meta is map
        && resource.data.meta.type == 'firestore/timestamp/1.0'
        && resource.data.refLookalike is map
        && resource.data.refLookalike.__type == 'reference';
    }
  }
}`,
      },
      ACTORS,
      {
        firestore: {
          'items/seeded': {
            createdAt: Timestamp.fromMillis(1_700_000_000_000),
            digest: Bytes.fromUint8Array(new Uint8Array([7, 8])),
            meta: { type: 'firestore/timestamp/1.0', seconds: 'not-a-timestamp' },
            refLookalike: { __type: 'reference', note: 'plain-map' },
          },
        },
      },
    );

    try {
      const readSeeded = await world.run({
        actor: 'owner', service: 'firestore', method: 'get', path: 'items/seeded',
      });
      const adminSeed = await world.run({
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'items/admin-seeded',
        data: {
          createdAt: Timestamp.fromMillis(1_700_000_050_000),
          digest: Bytes.fromUint8Array(new Uint8Array([5, 6])),
          meta: { type: 'firestore/timestamp/1.0', seconds: 'not-a-timestamp' },
          refLookalike: { __type: 'reference', note: 'plain-map' },
        },
      });
      const readAdminSeeded = await world.run({
        actor: 'owner', service: 'firestore', method: 'get', path: 'items/admin-seeded',
      });
      const clientCreate = await world.run({
        actor: 'owner',
        service: 'firestore',
        method: 'set',
        path: 'items/client-written',
        data: {
          createdAt: Timestamp.fromMillis(1_700_000_100_000),
          digest: Bytes.fromUint8Array(new Uint8Array([9, 10])),
          meta: { type: 'firestore/timestamp/1.0', seconds: 'not-a-timestamp' },
          refLookalike: { __type: 'reference', note: 'plain-map' },
        },
      });
      const readClientWritten = await world.run({
        actor: 'owner', service: 'firestore', method: 'get', path: 'items/client-written',
      });

      expect(readSeeded.decision).toBe('allow');
      expect(adminSeed.decision).toBe('allow');
      expect(readAdminSeeded.decision).toBe('allow');
      expect(clientCreate.decision).toBe('allow');
      expect(readClientWritten.decision).toBe('allow');
    } finally {
      world.dispose();
    }
  });
});

