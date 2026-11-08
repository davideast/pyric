import { describe, expect, test } from 'bun:test';
import { ProbeWorld } from '../../../src/assurance-surface/probes/world.js';
import type { ProbeActor } from '../../../src/assurance-surface/probes/types.js';

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
});
