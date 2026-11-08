import { describe, expect, test } from 'bun:test';
import { lookupSeeds } from '../../../src/assurance-surface/probes/prerequisites.js';
import type { ProbeActor } from '../../../src/assurance-surface/probes/types.js';
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
