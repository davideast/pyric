/**
 * Answering many requests in one call: every case keeps its own verdict, the
 * order is the order they were sent in, and the summary counts the verdicts so
 * a caller reads the shape of the answer before reading the cases.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { simulateCases } from '../../../src/bridge/surface/rules-batch.js';
import { FIRESTORE_RULES } from '../../../src/bridge/surface/rules-engines/firestore.js';
import type { SurfaceContext } from '../../../src/bridge/surface/types.js';

const OWNER_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /orders/{orderId} {
      allow read: if request.auth != null;
    }
  }
}`;

/** One case's answer, as the batch reports it. */
interface CaseVerdict {
  operation: string;
  path: string;
  allowed: boolean;
  summary: string;
}

async function contextWithOwnerRules(): Promise<SurfaceContext> {
  const ctx = createSurfaceContext(initializeSandbox());
  await FIRESTORE_RULES.install(ctx, OWNER_RULES);
  return ctx;
}

describe('simulateCases', () => {
  it('answers every case in the order it was sent', async () => {
    const ctx = await contextWithOwnerRules();
    const result = await simulateCases(ctx, 'firestore', [
      { operation: 'get', path: 'orders/o1', uid: 'alice' },
      { operation: 'get', path: 'orders/o2' },
      { operation: 'get', path: 'invoices/i1', uid: 'alice' },
    ]);

    expect(result.ok).toBe(true);
    const cases = (result.data as { cases: CaseVerdict[] }).cases;
    expect(cases.map((one) => one.path)).toEqual(['orders/o1', 'orders/o2', 'invoices/i1']);
    expect(cases.map((one) => one.allowed)).toEqual([true, false, false]);
  });

  it('counts the verdicts in the summary', async () => {
    const ctx = await contextWithOwnerRules();
    const result = await simulateCases(ctx, 'firestore', [
      { operation: 'get', path: 'orders/o1', uid: 'alice' },
      { operation: 'get', path: 'orders/o2', uid: 'alice' },
      { operation: 'get', path: 'orders/o3' },
    ]);

    expect(result.summary).toBe('3 cases: 2 allow, 1 deny.');
  });

  it('refuses an empty case list rather than reporting nothing', async () => {
    const ctx = await contextWithOwnerRules();
    const result = await simulateCases(ctx, 'firestore', []);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('at least one case');
  });
});
