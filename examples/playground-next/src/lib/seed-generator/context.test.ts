import { describe, expect, test } from 'bun:test';

import { COFFEE_SHOP_SPEC } from '~/lib/agent/spec/coffee-shop.fixture';

import {
  buildSeedContextBundle,
  extractCollectionNamesFromApp,
  extractCollectionNamesFromRules,
} from './context';

describe('extractCollectionNamesFromRules', () => {
  test('finds root collection segments from match blocks', () => {
    const rules = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /menuItems/{id} { allow read: if true; }
    match /orders/{orderId} { allow read: if true; }
  }
}`;
    expect(extractCollectionNamesFromRules(rules)).toEqual(['menuItems', 'orders']);
  });
});

describe('extractCollectionNamesFromApp', () => {
  test('finds collection() string literals', () => {
    const app = `
import { collection } from 'firebase/firestore';
const q = collection(db, "menuItems");
const o = collection(db, 'orders');
`;
    expect(extractCollectionNamesFromApp(app)).toEqual(['menuItems', 'orders']);
  });
});

describe('buildSeedContextBundle', () => {
  test('includes spec when app.spec.json parses', async () => {
    const bundle = await buildSeedContextBundle({
      hint: 'demo menu',
      readFile: async (path) => {
        if (path === '/workspace/app.spec.json') {
          return JSON.stringify(COFFEE_SHOP_SPEC);
        }
        return null;
      },
    });
    expect(bundle.summary.hasSpec).toBe(true);
    expect(bundle.spec?.meta.title).toBe('Coffee shop ordering');
    expect(bundle.authoritativeIdentities?.length).toBe(3);
    expect(bundle.payload).toContain('menuItems');
    expect(bundle.payload).toContain('demo menu');
  });

  test('marks rules and app from workspace store', async () => {
    const { useWorkspaceStore } = await import('~/lib/store/workspace');
    useWorkspaceStore.getState().setRules('match /items/{id}');
    useWorkspaceStore.getState().setAppSource('collection(db, "items")');

    const bundle = await buildSeedContextBundle({
      readFile: async () => null,
    });
    expect(bundle.summary.hasRules).toBe(true);
    expect(bundle.summary.hasApp).toBe(true);
    expect(bundle.payload).toContain('items');
  });
});
