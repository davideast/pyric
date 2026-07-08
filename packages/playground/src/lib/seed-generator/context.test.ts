import { describe, expect, test } from 'bun:test';

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
  test('includes user hint and workspace-derived collections', async () => {
    const { useWorkspaceStore } = await import('~/lib/store/workspace');
    useWorkspaceStore.getState().setRules('match /menuItems/{id}');
    useWorkspaceStore.getState().setAppSource('collection(db, "orders")');

    const bundle = await buildSeedContextBundle({
      hint: 'demo menu',
      readFile: async () => null,
    });
    expect(bundle.payload).toContain('menuItems');
    expect(bundle.payload).toContain('orders');
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
