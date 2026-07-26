import { describe, expect, it } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';
import * as firestore from '../../src/firestore/index.ts';

describe('Firestore runtime ES classes and constructor tokens (Pillar 1)', () => {
  it('exports CACHE_SIZE_UNLIMITED as -1', () => {
    expect((firestore as any).CACHE_SIZE_UNLIMITED).toBe(-1);
  });

  it('exports FirestoreError class that extends Error', () => {
    const err = new (firestore as any).FirestoreError('permission-denied', 'Denied');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf((firestore as any).FirestoreError);
    expect(err.code).toBe('permission-denied');
    expect(err.name).toBe('FirestoreError');
  });

  it('exports DocumentReference, CollectionReference, Query classes for instanceof checks', () => {
    expect(typeof (firestore as any).DocumentReference).toBe('function');
    expect(typeof (firestore as any).CollectionReference).toBe('function');
    expect(typeof (firestore as any).Query).toBe('function');
  });

  it('exports DocumentSnapshot, QueryDocumentSnapshot, QuerySnapshot classes', () => {
    expect(typeof (firestore as any).DocumentSnapshot).toBe('function');
    expect(typeof (firestore as any).QueryDocumentSnapshot).toBe('function');
    expect(typeof (firestore as any).QuerySnapshot).toBe('function');
  });

  it('exports Transaction, WriteBatch, SnapshotMetadata, Firestore classes', () => {
    expect(typeof (firestore as any).Transaction).toBe('function');
    expect(typeof (firestore as any).WriteBatch).toBe('function');
    expect(typeof (firestore as any).SnapshotMetadata).toBe('function');
    expect(typeof (firestore as any).Firestore).toBe('function');
  });

  it('exports query constraint classes for instanceof verification', () => {
    expect(typeof (firestore as any).QueryConstraint).toBe('function');
    expect(typeof (firestore as any).QueryFieldFilterConstraint).toBe('function');
    expect(typeof (firestore as any).QueryCompositeFilterConstraint).toBe('function');
    expect(typeof (firestore as any).QueryOrderByConstraint).toBe('function');
    expect(typeof (firestore as any).QueryLimitConstraint).toBe('function');
    expect(typeof (firestore as any).QueryStartAtConstraint).toBe('function');
    expect(typeof (firestore as any).QueryEndAtConstraint).toBe('function');
  });

  it('exports AggregateField and AggregateQuerySnapshot classes and equality helpers', () => {
    expect(typeof (firestore as any).AggregateField).toBe('function');
    expect(typeof (firestore as any).AggregateQuerySnapshot).toBe('function');
    expect(typeof (firestore as any).aggregateFieldEqual).toBe('function');
    expect(typeof (firestore as any).aggregateQuerySnapshotEqual).toBe('function');

    const c1 = firestore.count();
    const c2 = firestore.count();
    expect((firestore as any).aggregateFieldEqual(c1, c2)).toBe(true);
  });

  it('live handles produced by doc() and collection() satisfy instanceof checks', () => {
    const app = initializeSandbox({ projectId: 'test-project' });
    const db = firestore.getFirestore(app);
    const colRef = firestore.collection(db, 'users');
    const docRef = firestore.doc(colRef, 'alice');
    expect(docRef).toBeInstanceOf((firestore as any).DocumentReference);
    expect(colRef).toBeInstanceOf((firestore as any).CollectionReference);
    expect(colRef).toBeInstanceOf((firestore as any).Query);
  });
});
