import { describe, expect, it } from 'bun:test';
import * as firestore from '../../src/firestore/index.ts';

describe('Firestore low-level public write plumbing (Pillar 5)', () => {
  it('exports ensureFirestoreConfigured and executeWrite', async () => {
    expect(typeof (firestore as any).ensureFirestoreConfigured).toBe('function');
    expect(typeof (firestore as any).executeWrite).toBe('function');
  });
});
