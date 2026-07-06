/**
 * Direct tests for the conformance-facing exports added to the spec
 * module (SF-S0c): `evaluateGrant` (the matrix's GRANT decision over a
 * concrete op) and `ownerUidFromPath` (path → owner uid). These are the
 * "minimal justified export" the traffic-conformance harness reuses
 * instead of duplicating condition semantics.
 */
import { describe, expect, it } from 'bun:test';
import { evaluateGrant } from './derive';
import { ownerUidFromPath, type CollectionSpec } from './schema';

const noteCol: CollectionSpec = {
  path: 'users/{uid}/notes/{noteId}',
  fields: [{ name: 'title', type: 'string' }],
};
const orderCol: CollectionSpec = {
  path: 'orders/{orderId}',
  ownerField: 'userId',
  fields: [{ name: 'userId', type: 'string' }],
};

describe('ownerUidFromPath', () => {
  it('resolves the uid from a rooted subcollection path', () => {
    expect(ownerUidFromPath(noteCol, 'users/alice/notes/n1')).toBe('alice');
  });
  it('resolves the uid from a single-wildcard path (users/{uid})', () => {
    const col: CollectionSpec = { path: 'users/{uid}', fields: [] };
    expect(ownerUidFromPath(col, 'users/bob')).toBe('bob');
  });
  it('returns null when the path shape does not match the template', () => {
    expect(ownerUidFromPath(noteCol, 'users/alice')).toBeNull();
    expect(ownerUidFromPath(noteCol, 'widgets/x/notes/n1')).toBeNull();
  });
  it('returns null for ownerField-owned collections (owner is in data)', () => {
    expect(ownerUidFromPath(orderCol, 'orders/o1')).toBeNull();
  });
});

describe('evaluateGrant', () => {
  it('a deny grant always denies', () => {
    const r = evaluateGrant('deny', { identity: { uid: 'alice' } });
    expect(r.decision).toBe('deny');
    expect(r.violated?.outcome).toBe('deny');
  });

  it('an empty grant (public) always grants', () => {
    const r = evaluateGrant([], { identity: null });
    expect(r.decision).toBe('grant');
    expect(r.violated).toBeNull();
  });

  it('authenticated: granted when signed in, denied when anonymous', () => {
    expect(evaluateGrant([{ kind: 'authenticated' }], { identity: { uid: 'a' } }).decision).toBe('grant');
    expect(evaluateGrant([{ kind: 'authenticated' }], { identity: null }).decision).toBe('deny');
  });

  it('owner: grant on match, deny on mismatch, indeterminate when unresolved', () => {
    expect(evaluateGrant([{ kind: 'owner' }], { identity: { uid: 'a' }, ownerUid: 'a' }).decision).toBe('grant');
    expect(evaluateGrant([{ kind: 'owner' }], { identity: { uid: 'a' }, ownerUid: 'b' }).decision).toBe('deny');
    // unresolved owner → indeterminate → NOT a denial
    const u = evaluateGrant([{ kind: 'owner' }], { identity: { uid: 'a' }, ownerUid: null });
    expect(u.decision).toBe('grant');
    expect(u.verdicts[0]!.outcome).toBe('indeterminate');
  });

  it('claim: matches deep-equal token values', () => {
    expect(evaluateGrant([{ kind: 'claim', name: 'role', equals: 'admin' }], { identity: { uid: 'a', token: { role: 'admin' } } }).decision).toBe('grant');
    expect(evaluateGrant([{ kind: 'claim', name: 'role', equals: 'admin' }], { identity: { uid: 'a', token: { role: 'user' } } }).decision).toBe('deny');
  });

  it('requiredFields / fieldEquals decided only with a payload', () => {
    expect(evaluateGrant([{ kind: 'requiredFields', fields: ['x'] }], { identity: null, data: { x: 1 } }).decision).toBe('grant');
    expect(evaluateGrant([{ kind: 'requiredFields', fields: ['x'] }], { identity: null, data: {} }).decision).toBe('deny');
    // no payload → indeterminate, never a false deny
    expect(evaluateGrant([{ kind: 'requiredFields', fields: ['x'] }], { identity: null }).decision).toBe('grant');
  });

  it('fieldImmutable denies a changed field, grants an absent/unchanged one', () => {
    const grant = [{ kind: 'fieldImmutable' as const, field: 'k' }];
    expect(evaluateGrant(grant, { identity: { uid: 'a' }, data: { k: 2 }, before: { k: 1 } }).decision).toBe('deny');
    expect(evaluateGrant(grant, { identity: { uid: 'a' }, data: { k: 1 }, before: { k: 1 } }).decision).toBe('grant');
    expect(evaluateGrant(grant, { identity: { uid: 'a' }, data: { other: 9 }, before: { k: 1 } }).decision).toBe('grant');
  });

  it('crossDoc / enumTransition / custom are always indeterminate (never a false deny)', () => {
    const cross = evaluateGrant([{ kind: 'crossDoc', collection: 'm', docIdFrom: 'i', remoteField: 'p', localField: 'p' }], { identity: { uid: 'a' }, data: { p: 1 } });
    expect(cross.decision).toBe('grant');
    expect(cross.verdicts[0]!.outcome).toBe('indeterminate');
    const custom = evaluateGrant([{ kind: 'custom', rulesExpr: 'x', rationale: 'y' }], { identity: { uid: 'a' } });
    expect(custom.verdicts[0]!.outcome).toBe('indeterminate');
  });

  it('reports the FIRST decidably-violated condition (AND semantics)', () => {
    const r = evaluateGrant(
      [{ kind: 'authenticated' }, { kind: 'owner' }],
      { identity: null, ownerUid: 'b' },
    );
    expect(r.decision).toBe('deny');
    expect(r.violated?.kind).toBe('authenticated');
  });
});
