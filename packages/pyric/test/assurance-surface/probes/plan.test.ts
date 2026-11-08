import { describe, expect, test } from 'bun:test';
import { ensureCounters, planProbes } from '../../../src/assurance-surface/probes/plan.js';
import type { AccessSite } from '../../../src/assurance-surface/code/types.js';
import type { ProbeActor } from '../../../src/assurance-surface/probes/types.js';

const owner: ProbeActor = { role: 'owner', uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice', token: {} };
const peer: ProbeActor = { role: 'peer', uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob', token: {} };

const CONTRACT_KINDS = new Set([
  'must-allow-denied',
  'foreign-slot-write',
  'foreign-update',
  'foreign-delete',
  'owner-forge-create',
  'owner-transfer',
  'attribution-spoof',
  'counter-integrity',
]);

describe('planProbes', () => {
  test('plans field-owned probes (including foreign-delete) for RTDB update that writes an auth.uid field on a collection item', () => {
    const site: AccessSite = {
      service: 'rtdb',
      op: 'update',
      path: 'rooms/$roomId/sessions/$sessionId',
      source: 'app.ts:12',
      resolution: 'resolved',
      pathVariables: [{ name: 'roomId' }, { name: 'sessionId' }],
      payload: {
        kind: 'object',
        open: false,
        fields: [
          { name: 'uid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
          { name: 'status', kind: 'string' },
        ],
      },
    };
    const probes = planProbes({ sites: [site], bindings: [], conditions: [], owner, peer });
    const kinds = new Set(probes.map((p) => p.kind));
    expect(kinds.has('foreign-update')).toBe(true);
    expect(kinds.has('foreign-delete')).toBe(true);
    expect(kinds.has('owner-forge-create')).toBe(true);
    for (const p of probes) expect(CONTRACT_KINDS.has(p.kind)).toBe(true);
  });

  test('never emits non-contract probe kinds even when seeded state has multi-user documents', () => {
    const site: AccessSite = {
      service: 'firestore',
      op: 'setDoc',
      path: 'users/{uid}',
      source: 'seed:users/u-alice',
      resolution: 'resolved',
      pathVariables: [{ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] }],
      payload: {
        kind: 'object',
        open: false,
        fields: [{ name: 'name', kind: 'string' }],
      },
    };
    const probes = planProbes({
      sites: [site],
      bindings: [],
      conditions: [],
      owner,
      peer,
      state: { firestore: { 'users/u-alice': { name: 'Alice' }, 'users/u-bob': { name: 'Bob' } } },
    });
    for (const p of probes) expect(CONTRACT_KINDS.has(p.kind)).toBe(true);
  });

  test('does not infer whole-record ownership from partial RTDB updates on shared entities without cleanup', () => {
    const sites: AccessSite[] = [
      {
        service: 'rtdb',
        op: 'update',
        path: 'rooms/$roomId/boards/$boardId',
        source: 'board.ts:10',
        resolution: 'resolved',
        pathVariables: [{ name: 'roomId' }, { name: 'boardId' }],
        payload: {
          kind: 'object',
          open: false,
          fields: [{ name: 'title', kind: 'string' }],
        },
      },
      {
        service: 'rtdb',
        op: 'update',
        path: 'rooms/$roomId/boards/$boardId',
        source: 'board.ts:20',
        resolution: 'resolved',
        pathVariables: [{ name: 'roomId' }, { name: 'boardId' }],
        payload: {
          kind: 'object',
          open: false,
          fields: [{ name: 'creatorUid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] }],
        },
      },
    ];
    const probes = planProbes({ sites, bindings: [], conditions: [], owner, peer });
    const kinds = new Set(probes.map((p) => p.kind));
    expect(kinds.has('foreign-update')).toBe(false);
    expect(kinds.has('owner-transfer')).toBe(false);
    expect(kinds.has('owner-forge-create')).toBe(false);
  });

  test('does not infer record ownership from optional auth.uid metadata when rules define no field bindings', () => {
    const site: AccessSite = {
      service: 'rtdb',
      op: 'set',
      path: 'rooms/$roomId/crdt/$docKey/awareness/$clientId',
      source: 'sync.ts:40',
      resolution: 'resolved',
      pathVariables: [{ name: 'roomId' }, { name: 'docKey' }, { name: 'clientId' }],
      payload: {
        kind: 'object',
        open: false,
        fields: [
          { name: 'uid', kind: 'string', optional: true, auth: [{ source: 'auth.uid', certainty: 'partial' }] },
          { name: 'updatedAt', kind: 'number' },
        ],
      },
    };
    const probes = planProbes({
      sites: [site],
      bindings: [
        {
          path: site.path,
          kind: 'incomingField',
          field: 'uid',
          strength: 'tentative',
          service: 'rtdb',
          evidence: 'code-only',
        },
      ],
      conditions: [],
      owner,
      peer,
    });
    const kinds = new Set(probes.map((p) => p.kind));
    expect(kinds.has('foreign-delete')).toBe(false);
    expect(kinds.has('owner-forge-create')).toBe(false);
  });

  test('preserves sibling nested fields in counter seed setup and guards empty-path steps', () => {
    const createSite: AccessSite = {
      service: 'firestore',
      op: 'setDoc',
      path: 'posts/{postId}',
      source: 'posts.ts:10',
      resolution: 'resolved',
      pathVariables: [{ name: 'postId' }],
      payload: {
        kind: 'object',
        open: false,
        fields: [
          { name: 'title', kind: 'string', literal: 'Hello' },
          { name: 'stats', kind: 'object' },
          { name: 'stats.likes', kind: 'number', literal: 5 },
        ],
      },
    };
    const incSite: AccessSite = {
      service: 'firestore',
      op: 'updateDoc',
      path: 'posts/{postId}',
      source: 'posts.ts:20',
      resolution: 'resolved',
      pathVariables: [{ name: 'postId' }],
      payload: {
        kind: 'object',
        open: false,
        fields: [{ name: 'stats.views', kind: 'increment' }],
      },
    };
    const probes = planProbes({ sites: [createSite, incSite], bindings: [], conditions: [], owner, peer });
    const counterProbe = probes.find((p) => p.kind === 'counter-integrity');
    expect(counterProbe?.seed).toEqual([
      {
        actor: 'admin',
        service: 'firestore',
        method: 'set',
        path: 'posts/v-postId',
        data: { title: 'Hello', stats: { likes: 5, views: 0 } },
      },
    ]);

    const multiStep = { actor: 'admin' as const, service: 'rtdb' as const, method: 'set' as const, path: '', data: { 'posts/p1': { views: 1 } } };
    expect(ensureCounters(multiStep, ['views'], '/')).toEqual(multiStep);
  });

  test('assigns proven vs flagged certainty from rule confirmation and exact resolved client provenance', () => {
    const seedSlotSite: AccessSite = {
      service: 'firestore',
      op: 'setDoc',
      path: 'profiles/{uid}',
      source: 'seed:profiles/u-alice',
      resolution: 'resolved',
      pathVariables: [{ name: 'uid', auth: [{ source: 'auth.uid', certainty: 'exact' }] }],
      payload: { kind: 'object', open: false, fields: [{ name: 'bio', kind: 'string' }] },
    };
    const unconfirmedSeed = planProbes({ sites: [seedSlotSite], bindings: [], conditions: [], owner, peer });
    expect(unconfirmedSeed.find((p) => p.kind === 'foreign-slot-write')?.status).toBe('flagged');

    const confirmedSeed = planProbes({
      sites: [seedSlotSite],
      bindings: [
        {
          path: 'profiles/{uid}',
          kind: 'pathVar',
          field: '{uid}',
          strength: 'strong',
          service: 'firestore',
          evidence: 'rules+code',
          depth: { decidedAt: 'profiles/{uid}', writtenAt: ['profiles/{uid}'], keyedMap: false },
          evidenceText: 'request.auth.uid == uid',
        },
      ],
      conditions: [],
      owner,
      peer,
    });
    expect(confirmedSeed.find((p) => p.kind === 'foreign-slot-write')?.status).toBe('proven');

    const partialResolutionSite: AccessSite = {
      service: 'firestore',
      op: 'addDoc',
      path: 'notes/{autoId}',
      source: 'notes.ts:15',
      resolution: 'partial',
      pathVariables: [{ name: 'autoId' }],
      payload: {
        kind: 'object',
        open: false,
        fields: [
          { name: 'authorUid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
          { name: 'body', kind: 'string' },
        ],
      },
    };
    const partialResProbes = planProbes({ sites: [partialResolutionSite], bindings: [], conditions: [], owner, peer });
    expect(partialResProbes.find((p) => p.kind === 'owner-forge-create')?.status).toBe('flagged');

    const partialAuthSite: AccessSite = {
      ...partialResolutionSite,
      resolution: 'resolved',
      payload: {
        kind: 'object',
        open: false,
        fields: [
          { name: 'authorUid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'partial' }] },
          { name: 'body', kind: 'string' },
        ],
      },
    };
    const partialAuthProbes = planProbes({ sites: [partialAuthSite], bindings: [], conditions: [], owner, peer });
    expect(partialAuthProbes.find((p) => p.kind === 'owner-forge-create')?.status).toBe('flagged');

    const mixedSlotSite: AccessSite = {
      service: 'rtdb',
      op: 'set',
      path: 'presence/$key',
      source: 'presence.ts:8',
      resolution: 'resolved',
      pathVariables: [
        {
          name: 'key',
          auth: [
            { source: 'auth.uid', certainty: 'exact' },
            { source: 'auth.displayName', certainty: 'partial' },
          ],
        },
      ],
      payload: { kind: 'string', open: false, fields: [], literal: 'online' },
    };
    const mixedSlotProbes = planProbes({ sites: [mixedSlotSite], bindings: [], conditions: [], owner, peer });
    expect(mixedSlotProbes.find((p) => p.kind === 'foreign-slot-write')?.status).toBe('flagged');

    const exactFieldSite: AccessSite = {
      ...partialResolutionSite,
      resolution: 'resolved',
    };
    const exactProbes = planProbes({ sites: [exactFieldSite], bindings: [], conditions: [], owner, peer });
    expect(exactProbes.find((p) => p.kind === 'owner-forge-create')?.status).toBe('proven');
  });
});

