import { describe, expect, test } from 'bun:test';

import type { AsyncAdminSeedSurface } from '~/lib/sandbox/seed-apply';

import { applySeedProposal } from './apply-proposal';
import type { SeedProposalV1 } from './schema';

function makeFakeAdmin(): AsyncAdminSeedSurface & { store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    async setDocument(path, data) {
      store.set(path, data);
    },
    async deleteDocument(path) {
      store.delete(path);
      return { deleted: true };
    },
    async listDocuments(prefix) {
      return [...store.entries()]
        .filter(([p]) => p.startsWith(`${prefix}/`) && p.split('/').length === 2)
        .map(([path, data]) => ({ path, data }));
    },
  };
}

const PROPOSAL: SeedProposalV1 = {
  version: 1,
  firestore: {
    menuItems: {
      m1: { name: 'Latte', price: 5 },
    },
    orders: [{ userId: 'alice', itemId: 'm1', price: 5, qty: 1, status: 'placed' }],
  },
};

describe('applySeedProposal', () => {
  test('applies firestore collections via admin surface', async () => {
    const admin = makeFakeAdmin();
    const result = await applySeedProposal(admin, PROPOSAL);
    expect(result.firestore.applied).toBe(2);
    expect(result.firestore.collections).toBe(2);
    expect(admin.store.has('menuItems/m1')).toBe(true);
    expect([...admin.store.keys()].some((k) => k.startsWith('orders/'))).toBe(true);
  });

  test('applies proposal auth users', async () => {
    const admin = makeFakeAdmin();
    const result = await applySeedProposal(
      admin,
      {
        version: 1,
        firestore: PROPOSAL.firestore,
        auth: [{ uid: 'alice' }, { uid: 'bob' }],
      },
    );
    expect(result.auth.created).toEqual(['alice', 'bob']);
  });
});
