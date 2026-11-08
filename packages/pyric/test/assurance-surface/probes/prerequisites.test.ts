import { describe, expect, test } from 'bun:test';
import {
  crossServiceLookupSeeds,
  lookupSeeds,
} from '../../../src/assurance-surface/probes/prerequisites.js';
import type { ProbeActor } from '../../../src/assurance-surface/probes/types.js';
import { projectRuleSurface } from '../../../src/assurance-surface/rules/rule-surface.js';
import type { OwnerCondition } from '../../../src/assurance-surface/rules/types.js';

const ACTORS: ProbeActor[] = [
  { role: 'owner', uid: 'u-owner', email: 'owner@probe.local', displayName: 'Owner', token: {} },
  { role: 'peer', uid: 'u-peer', email: 'peer@probe.local', displayName: 'Peer', token: {} },
];

describe('lookupSeeds', () => {
  test('seeds per-actor uid field on each actor lookup document rather than copying actors[0].uid', () => {
    const conditions: OwnerCondition[] = [
      {
        service: 'firestore',
        path: 'orgs/{orgId}/items/{itemId}',
        ops: ['create', 'update'],
        kind: 'lookup',
        field: 'orgs/{orgId}/members/{auth.uid}#uid',
        relation: 'equals',
        required: true,
        source: 'firestore.rules:6',
        expression: 'get(...).data.uid == request.auth.uid',
      },
    ];

    const seeds = lookupSeeds(
      'firestore',
      'orgs/{orgId}/items/{itemId}',
      'orgs/org-9/items/item-1',
      conditions,
      [],
      ACTORS,
    );

    expect(seeds).toEqual([
      {
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/org-9/members/u-owner',
        data: { uid: 'u-owner' },
      },
      {
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/org-9/members/u-peer',
        data: { uid: 'u-peer' },
      },
    ]);
  });

  test('seeds shared contains lookup document with all actor uids and skips child-under-uid lookups', () => {
    const conditions: OwnerCondition[] = [
      {
        service: 'firestore',
        path: 'teams/{teamId}/docs/{docId}',
        ops: ['read'],
        kind: 'lookup',
        field: 'teams/{teamId}#members',
        relation: 'contains',
        required: true,
        source: 'firestore.rules:4',
        expression: 'request.auth.uid in get(...).data.members',
      },
      {
        service: 'rtdb',
        path: 'teams/$teamId',
        ops: ['read'],
        kind: 'lookup',
        field: 'teams/$teamId/members/{auth.uid}/removed',
        relation: 'exists',
        required: false,
        source: 'database.rules.json#/rules/teams/$teamId/.read',
        expression: '...',
      },
    ];

    const fsSeeds = lookupSeeds(
      'firestore',
      'teams/{teamId}/docs/{docId}',
      'teams/t-1/docs/d-1',
      conditions,
      [],
      ACTORS,
    );
    expect(fsSeeds).toEqual([
      {
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'teams/t-1',
        data: { members: ['u-owner', 'u-peer'] },
      },
    ]);

    const rtdbSeeds = lookupSeeds('rtdb', 'teams/$teamId/docs/$docId', 'teams/t-1/docs/d-1', conditions, [], ACTORS);
    expect(rtdbSeeds).toEqual([]);
  });

  test('binds __proto__ rule variables as own properties without dropping them', () => {
    const conditions: OwnerCondition[] = [
      {
        service: 'rtdb',
        path: 'teams/$__proto__',
        ops: ['write'],
        kind: 'lookup',
        field: 'teams/$__proto__/members/{auth.uid}',
        relation: 'exists',
        required: true,
        source: 'database.rules.json#/rules/teams/$__proto__/.write',
        expression: 'root.child(...).exists()',
      },
    ];
    const seeds = lookupSeeds(
      'rtdb',
      'teams/$__proto__/items/$itemId',
      'teams/t-9/items/i-1',
      conditions,
      [],
      ACTORS,
    );
    expect(seeds.map((s) => s.path)).toEqual([
      'teams/t-9/members/u-owner',
      'teams/t-9/members/u-peer',
    ]);
  });
});

describe('crossServiceLookupSeeds', () => {
  test('synthesizes admin Firestore prerequisite docs from RuleSurface crossServiceReads for positive actor only when requested', () => {
    const surface = projectRuleSurface({
      storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/{allPaths=**} {
      allow write: if request.auth != null
        && firestore.exists(/databases/(default)/documents/orgs/$(orgId))
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'editor'
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.ownerUid == request.auth.uid;
    }
  }
}`,
    });
    const entry = surface.entries[0]!;
    const seeds = crossServiceLookupSeeds({
      storageTemplate: 'orgs/{teamId}/reports/{fileId}',
      rulePattern: entry.pattern,
      concreteStoragePath: 'orgs/acme/reports/q1.pdf',
      lookups: entry.crossServiceReads,
      actors: [ACTORS[0]!],
    });

    expect(seeds).toEqual([
      {
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/acme',
        data: { active: true },
      },
      {
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/acme/members/u-owner',
        data: { role: 'editor', ownerUid: 'u-owner' },
      },
    ]);
  });

  test('preserves existing satisfying live Firestore docs in WorldState without overwriting them', () => {
    const surface = projectRuleSurface({
      storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/files/{fileId} {
      allow write: if firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.role == 'editor';
    }
  }
}`,
    });
    const entry = surface.entries[0]!;
    const seeds = crossServiceLookupSeeds({
      storageTemplate: 'orgs/{orgId}/files/{fileId}',
      rulePattern: entry.pattern,
      concreteStoragePath: 'orgs/acme/files/doc.pdf',
      lookups: entry.crossServiceReads,
      actors: [ACTORS[0]!],
      state: {
        firestore: {
          'orgs/acme/members/u-owner': { role: 'editor', joinedAt: 1700000000 },
        },
      },
    });

    expect(seeds).toEqual([]);
  });

  test('seeds boolean false, non-colliding scalars, and empty ban lists for negated cross-service checks', () => {
    const surface = projectRuleSurface({
      storage: `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /orgs/{orgId}/files/{fileId} {
      allow write: if firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.status != 'active'
        && firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.disabled == false
        && !firestore.get(/databases/(default)/documents/orgs/$(orgId)/members/$(request.auth.uid)).data.suspended
        && !(request.auth.uid in firestore.get(/databases/(default)/documents/orgs/$(orgId)).data.bannedUids);
    }
  }
}`,
    });
    const entry = surface.entries[0]!;
    const seeds = crossServiceLookupSeeds({
      storageTemplate: 'orgs/{orgId}/files/{fileId}',
      rulePattern: entry.pattern,
      concreteStoragePath: 'orgs/acme/files/doc.pdf',
      lookups: entry.crossServiceReads,
      actors: [ACTORS[0]!],
    });

    expect(seeds).toEqual([
      {
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/acme/members/u-owner',
        data: { status: 'ok', disabled: false, suspended: false },
      },
      {
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'orgs/acme',
        data: { bannedUids: [] },
      },
    ]);

    const satisfiedSeeds = crossServiceLookupSeeds({
      storageTemplate: 'orgs/{orgId}/files/{fileId}',
      rulePattern: entry.pattern,
      concreteStoragePath: 'orgs/acme/files/doc.pdf',
      lookups: entry.crossServiceReads,
      actors: [ACTORS[0]!],
      state: {
        firestore: {
          'orgs/acme/members/u-owner': { status: 'ok', disabled: false, suspended: false },
          'orgs/acme': { bannedUids: ['u-someone-else'] },
        },
      },
    });
    expect(satisfiedSeeds).toEqual([]);
  });
});
