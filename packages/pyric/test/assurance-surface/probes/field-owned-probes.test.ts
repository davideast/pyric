import { describe, expect, test } from 'bun:test';
import type { AccessSite, PayloadShape } from '../../../src/assurance-surface/code/types.js';
import {
  contentOnly,
  editableField,
  editsContent,
  planFieldOwned,
} from '../../../src/assurance-surface/probes/field-owned-probes.js';
import { stepFor } from '../../../src/assurance-surface/probes/step-builder.js';
import type { Probe, ProbeActor } from '../../../src/assurance-surface/probes/types.js';

const owner: ProbeActor = { role: 'owner', uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice', token: {} };
const peer: ProbeActor = { role: 'peer', uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob', token: {} };

describe('field-owned-probes', () => {
  test('editsContent, contentOnly, and editableField filter out owner, attribution, and counter fields', () => {
    const shape: PayloadShape = {
      kind: 'object',
      open: false,
      fields: [
        { name: 'authorUid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
        { name: 'authorName', kind: 'string', auth: [{ source: 'auth.displayName', certainty: 'exact' }] },
        { name: 'likes', kind: 'increment' },
        { name: 'body', kind: 'string' },
      ],
    };
    expect(editsContent(shape, ['authorUid'])).toBe(true);
    expect(contentOnly(shape).fields.map((f) => f.name)).toEqual(['authorUid', 'authorName', 'body']);
    expect(editableField(shape, ['authorUid'])).toBe('body');

    const counterOnly: PayloadShape = {
      kind: 'object',
      open: false,
      fields: [{ name: 'likes', kind: 'increment' }],
    };
    expect(editsContent(counterOnly, ['authorUid'])).toBe(false);
  });

  test('planFieldOwned emits foreign-update, owner-transfer, foreign-delete, and owner-forge-create when client updates and deletes', () => {
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
          { name: 'ownerUid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
          { name: 'body', kind: 'string' },
        ],
      },
    };
    const updateSite: AccessSite = {
      service: 'firestore',
      op: 'updateDoc',
      path: 'posts/{postId}',
      source: 'posts.ts:20',
      resolution: 'resolved',
      pathVariables: [{ name: 'postId' }],
      payload: {
        kind: 'object',
        open: false,
        fields: [{ name: 'body', kind: 'string' }],
      },
    };
    const deleteSite: AccessSite = {
      service: 'firestore',
      op: 'deleteDoc',
      path: 'posts/{postId}',
      source: 'posts.ts:30',
      resolution: 'resolved',
      pathVariables: [{ name: 'postId' }],
    };
    const planned: Omit<Probe, 'id'>[] = [];
    const actors = { owner, peer };
    planFieldOwned(
      createSite,
      ['ownerUid'],
      'proven',
      { sites: [createSite, updateSite, deleteSite], bindings: [], conditions: [], owner, peer },
      actors,
      (s, actor, opts) => stepFor(s, actor, actors, opts),
      () => [],
      (p) => planned.push(p),
    );
    expect(planned.map((p) => p.kind)).toEqual([
      'foreign-update',
      'owner-transfer',
      'foreign-delete',
      'owner-forge-create',
    ]);
    for (const p of planned) expect(p.status).toBe('proven');
  });
});
