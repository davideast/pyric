/**
 * How the surface reaches the assurance run loop: one campaign store per
 * sandbox, and a clone of the sandbox that contacts nothing.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { getFirestore } from 'pyric/sandbox/admin-firestore';

import {
  callAssuranceOperation,
  campaignStore,
  sandboxRules,
} from '../../../src/bridge/surface/assurance-campaigns.js';
import { createSurfaceContext } from '../../../src/bridge/surface/context.js';
import { OPEN_ORDER_RULES } from '../../fixtures/order-rules.js';

function contextWithOrders() {
  const sandbox = initializeSandbox();
  setRules(sandbox, OPEN_ORDER_RULES);
  return createSurfaceContext(sandbox, process.cwd());
}

describe('the campaigns one sandbox holds', () => {
  it('gives each sandbox its own store, so a campaign name is free in the next one', () => {
    const first = initializeSandbox();
    const second = initializeSandbox();
    expect(campaignStore(first)).toBe(campaignStore(first));
    expect(campaignStore(first)).not.toBe(campaignStore(second));
  });

  it('reads back the rules the sandbox is enforcing', () => {
    const ctx = contextWithOrders();
    expect(sandboxRules(ctx).firestore).toBe(OPEN_ORDER_RULES);
  });
});

describe('cloning the sandbox this process owns', () => {
  it('copies the live documents and accounts into the campaign without touching them', async () => {
    const ctx = contextWithOrders();
    const db = getFirestore(ctx.sandbox.withAuth({ uid: 'alice' }));
    await db.doc('orders/o1').set({ owner: 'alice', total: 10 });

    const attached = await callAssuranceOperation(ctx, 'firebase_assurance_attach', {
      url: 'pyric:in-process-sandbox',
      campaignId: 'owned',
    });
    expect(attached.ok).toBe(true);
    const data = attached.data as {
      inventory: { firestoreDocuments: number };
      source: { transport: string; readOnly: boolean };
    };
    expect(data.inventory.firestoreDocuments).toBe(1);
    expect(data.source.transport).toBe('in-process-sandbox');
    expect(data.source.readOnly).toBe(true);

    const live = await db.doc('orders/o1').get();
    expect(live.data()).toEqual({ owner: 'alice', total: 10 });
  });

  it('reports a library refusal as a failed result rather than throwing', async () => {
    const ctx = contextWithOrders();
    const refused = await callAssuranceOperation(ctx, 'firebase_assurance_inspect', {
      campaignId: 'nothing-started',
      probeId: 'probe-1',
    });
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('nothing-started');
  });

  it('throws for a library tool that does not exist, which is a defect and not a call', async () => {
    const ctx = contextWithOrders();
    await expect(callAssuranceOperation(ctx, 'firebase_assurance_teleport', {})).rejects.toThrow(
      'firebase_assurance_teleport',
    );
  });
});
