import { describe, expect, test } from 'bun:test';
import type { AccessSite } from '../../../src/assurance-surface/code/types.js';
import {
  creator,
  isCleanup,
  opOf,
  recordPath,
  shareUidVariables,
  siblingsOf,
  stepFor,
} from '../../../src/assurance-surface/probes/step-builder.js';
import type { ProbeActor } from '../../../src/assurance-surface/probes/types.js';

const owner: ProbeActor = { role: 'owner', uid: 'u-alice', email: 'alice@example.test', displayName: 'Alice', token: {} };
const peer: ProbeActor = { role: 'peer', uid: 'u-bob', email: 'bob@example.test', displayName: 'Bob', token: {} };

describe('step-builder', () => {
  test('shareUidVariables propagates uid provenance and pattern from sibling sites at the same shape', () => {
    const createSite: AccessSite = {
      service: 'rtdb',
      op: 'set',
      path: 'rooms/$roomId/members/$memberKey',
      source: 'join.ts:10',
      resolution: 'resolved',
      pathVariables: [
        { name: 'roomId' },
        { name: 'memberKey', auth: [{ source: 'auth.uid', certainty: 'partial' }], pattern: '{auth.uid}:web' },
      ],
    };
    const removeSite: AccessSite = {
      service: 'rtdb',
      op: 'remove',
      path: 'rooms/$id/members/$key',
      source: 'leave.ts:15',
      resolution: 'resolved',
      pathVariables: [{ name: 'id' }, { name: 'key' }],
    };
    const shared = shareUidVariables([createSite, removeSite]);
    expect(shared[1].pathVariables?.[1]).toEqual({
      name: 'key',
      auth: [{ source: 'auth.uid', certainty: 'partial' }],
      pattern: '{auth.uid}:web',
    });
  });

  test('isCleanup, opOf, stepFor, and recordPath handle merge setDoc, multi-path RTDB updates, and null sets', () => {
    const mergeSite: AccessSite = {
      service: 'firestore',
      op: 'setDoc',
      path: 'docs/{docId}',
      source: 'doc.ts:4',
      resolution: 'resolved',
      pathVariables: [{ name: 'docId' }],
      payload: { kind: 'object', open: false, merge: true, fields: [{ name: 'title', kind: 'string', literal: 'hello' }] },
    };
    const mergeStep = stepFor(mergeSite, 'owner', { owner, peer });
    expect(mergeStep).toEqual({
      actor: 'owner',
      service: 'firestore',
      method: 'set',
      path: 'docs/v-docId',
      data: { title: 'hello' },
      merge: true,
    });
    expect(opOf(mergeSite)).toBe('create');

    const multiSite: AccessSite = {
      service: 'rtdb',
      op: 'update',
      path: 'rooms/$roomId/status',
      multiPath: true,
      source: 'rt.ts:8',
      resolution: 'resolved',
      pathVariables: [{ name: 'roomId' }],
      payload: { kind: 'string', open: false, fields: [], literal: 'online' },
    };
    const multiStep = stepFor(multiSite, 'owner', { owner, peer });
    expect(multiStep.path).toBe('');
    expect(recordPath(multiStep)).toBe('rooms/v-roomId/status');

    const nullSet: AccessSite = {
      service: 'rtdb',
      op: 'onDisconnect.set',
      path: 'presence/$uid',
      source: 'presence.ts:5',
      resolution: 'resolved',
      payload: { kind: 'null', open: false, fields: [] },
    };
    expect(isCleanup(nullSet)).toBe(true);
    expect(opOf(nullSet)).toBe('delete');
  });

  test('creator prefers set writes carrying uid fields and siblingsOf finds scoped cleanup peers', () => {
    const updatePartial: AccessSite = {
      service: 'rtdb',
      op: 'update',
      path: 'rooms/$id/call/participants/$uid',
      source: 'call.ts:10',
      resolution: 'resolved',
      payload: { kind: 'object', open: false, fields: [{ name: 'muted', kind: 'boolean' }] },
    };
    const fullSet: AccessSite = {
      service: 'rtdb',
      op: 'set',
      path: 'rooms/$id/call/participants/$uid',
      source: 'call.ts:4',
      resolution: 'resolved',
      payload: {
        kind: 'object',
        open: false,
        fields: [
          { name: 'uid', kind: 'string', auth: [{ source: 'auth.uid', certainty: 'exact' }] },
          { name: 'muted', kind: 'boolean' },
        ],
      },
    };
    const leaveParticipants: AccessSite = {
      service: 'rtdb',
      op: 'remove',
      path: 'rooms/$id/call/participants/$uid',
      source: 'call.ts:20',
      resolution: 'resolved',
    };
    const clearSignals: AccessSite = {
      service: 'rtdb',
      op: 'remove',
      path: 'rooms/$id/call/signals/$uid/$peer',
      source: 'call.ts:21',
      resolution: 'resolved',
    };
    const all = [updatePartial, fullSet, leaveParticipants, clearSignals];
    expect(creator(leaveParticipants, all)).toBe(fullSet);
    expect(siblingsOf(clearSignals, all)).toEqual([leaveParticipants]);
  });
});
