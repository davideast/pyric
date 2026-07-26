import { describe, expect, it } from 'bun:test';
import * as firestore from '../../src/firestore/index.ts';

describe('Firestore SSR snapshot dehydration and listener resume (Pillar 4)', () => {
  it('exports documentSnapshotFromJSON, querySnapshotFromJSON, onSnapshotResume', () => {
    expect(typeof (firestore as any).documentSnapshotFromJSON).toBe('function');
    expect(typeof (firestore as any).querySnapshotFromJSON).toBe('function');
    expect(typeof (firestore as any).onSnapshotResume).toBe('function');
  });
});
