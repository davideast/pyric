import { describe, expect, it } from 'bun:test';
import * as firestore from '../../src/firestore/index.ts';

describe('Firestore offline bundles and named query hydration (Pillar 3)', () => {
  it('exports loadBundle, namedQuery, and LoadBundleTask class', async () => {
    expect(typeof (firestore as any).loadBundle).toBe('function');
    expect(typeof (firestore as any).namedQuery).toBe('function');
    expect(typeof (firestore as any).LoadBundleTask).toBe('function');

    const mockDb = {} as any;
    const task = (firestore as any).loadBundle(mockDb, 'mock-bundle-payload');
    expect(task).toBeInstanceOf((firestore as any).LoadBundleTask);
    const progress = await task;
    expect(progress).toBeDefined();
    expect(progress.taskState).toBe('Success');
  });
});
