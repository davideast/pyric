/**
 * The adapter between the canonical operation vocabulary and the method
 * records that implement it: most operations map straight across, a few
 * translate their arguments, and one, `switch_auth_identity`, picks its
 * record from the arguments rather than naming one.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../../src/bridge/surface/context.js';
import {
  CANONICAL_OPERATION_IDS,
  runCanonicalOperation,
} from '../../../../src/bridge/surface/render/canonical-dispatch.js';

function freshContext() {
  return createSurfaceContext(initializeSandbox());
}

describe('CANONICAL_OPERATION_IDS', () => {
  it('is sorted and names every route this module dispatches', () => {
    expect([...CANONICAL_OPERATION_IDS]).toEqual([...CANONICAL_OPERATION_IDS].sort());
    expect(CANONICAL_OPERATION_IDS).toContain('get_firestore_document');
    expect(CANONICAL_OPERATION_IDS).toContain('switch_auth_identity');
    expect(CANONICAL_OPERATION_IDS).toContain('reset_sandbox');
  });
});

describe('runCanonicalOperation', () => {
  it('throws on an operation no route names', async () => {
    await expect(runCanonicalOperation('not_an_operation', {}, freshContext())).rejects.toThrow(
      "unknown operation 'not_an_operation'",
    );
  });

  it('dispatches a route with no argument translation straight to its record', async () => {
    const ctx = freshContext();
    const written = await runCanonicalOperation(
      'write_firestore_document',
      { path: 'posts/p1', data: { title: 'hi' } },
      ctx,
    );
    expect(written.ok).toBe(true);
    const read = await runCanonicalOperation('get_firestore_document', { path: 'posts/p1' }, ctx);
    expect(read.ok).toBe(true);
  });

  it('translates merge into the setDoc record options shape', async () => {
    const ctx = freshContext();
    await runCanonicalOperation(
      'write_firestore_document',
      { path: 'posts/p2', data: { title: 'a', body: 'b' } },
      ctx,
    );
    const merged = await runCanonicalOperation(
      'write_firestore_document',
      { path: 'posts/p2', data: { title: 'a2' }, merge: true },
      ctx,
    );
    expect(merged.ok).toBe(true);
    const read = await runCanonicalOperation('get_firestore_document', { path: 'posts/p2' }, ctx);
    expect((read.data as { data: Record<string, unknown> }).data).toMatchObject({
      title: 'a2',
      body: 'b',
    });
  });

  it('picks the identity record the mode argument names', async () => {
    const ctx = freshContext();
    const admin = await runCanonicalOperation('switch_auth_identity', { mode: 'admin' }, ctx);
    expect(admin.summary).toBe('Acting as admin');

    const asUid = await runCanonicalOperation(
      'switch_auth_identity',
      { mode: 'uid', uid: 'alice' },
      ctx,
    );
    expect(asUid.summary).toBe('Acting as alice');
  });

  it('throws on an identity mode the route does not recognise', async () => {
    await expect(
      runCanonicalOperation('switch_auth_identity', { mode: 'ghost' }, freshContext()),
    ).rejects.toThrow("unknown identity mode 'ghost'");
  });

  it('carries only confirm through to reset_sandbox, so an unconfirmed reset is refused', async () => {
    const refused = await runCanonicalOperation(
      'reset_sandbox',
      { confirm: false, somethingElse: true },
      freshContext(),
    );
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('confirm');
  });
});
