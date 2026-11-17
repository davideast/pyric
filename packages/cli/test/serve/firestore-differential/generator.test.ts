import { describe, expect, test } from 'bun:test';
import { generateSequence } from './generator.js';

describe('Firestore differential sequence generator', () => {
  test('is strictly deterministic for the same seed and round-trips through JSON', () => {
    const first = generateSequence(42, { minSteps: 35, maxSteps: 35 });
    const second = generateSequence(42, { minSteps: 35, maxSteps: 35 });
    expect(first).toEqual(second);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(first.steps).toHaveLength(35);
  });

  test('covers writes, sentinels, batches, transactions, compound queries, listeners, named dbs, and rules across 40 seeds', () => {
    const ops = new Set<string>();
    const setModes = new Set<string>();
    const whereOps = new Set<string>();
    const txnScripts = new Set<string>();
    const dbs = new Set<number>();
    let sawCompositeFilter = false;
    let sawSnapshotCursor = false;
    let sawValueCursor = false;
    let sawLimitToLast = false;
    let sawArrayValuedInCandidate = false;
    let sawArrayValuedNotInCandidate = false;

    for (let seed = 1; seed <= 40; seed++) {
      const seq = generateSequence(seed, { minSteps: 35, maxSteps: 35 });
      for (const step of seq.steps) {
        ops.add(step.op);
        if ('db' in step) {
          dbs.add(step.db);
        }
        if (step.op === 'setDoc') {
          setModes.add(step.mode.kind);
        }
        if (step.op === 'runTransaction') {
          txnScripts.add(step.script);
        }
        if (step.op === 'getDocs' || step.op === 'listenQuery') {
          const q = step.query;
          if (q.filter !== undefined) {
            if (q.filter.kind === 'where') {
              whereOps.add(q.filter.op);
              const val = q.filter.value;
              const hasArrayElement =
                val !== null
                && typeof val === 'object'
                && '$array' in val
                && val.$array.some(
                  (entry) => entry !== null && typeof entry === 'object' && '$array' in entry,
                );
              if (q.filter.op === 'in' && hasArrayElement) {
                sawArrayValuedInCandidate = true;
              }
              if (q.filter.op === 'not-in' && hasArrayElement) {
                sawArrayValuedNotInCandidate = true;
              }
            } else {
              sawCompositeFilter = true;
            }
          }
          if (q.limitToLast !== undefined) {
            sawLimitToLast = true;
          }
          for (const cursor of [q.startAt, q.startAfter, q.endAt, q.endBefore]) {
            if (cursor?.mode === 'docSnap') sawSnapshotCursor = true;
            if (cursor?.mode === 'values') sawValueCursor = true;
          }
        }
      }
    }

    expect([...ops].sort()).toEqual([
      'addDoc',
      'deleteDoc',
      'getDoc',
      'getDocs',
      'listenDoc',
      'listenQuery',
      'refreshToken',
      'rules',
      'runTransaction',
      'setDoc',
      'signIn',
      'signInAnonymously',
      'signOut',
      'unlisten',
      'updateDoc',
      'writeBatch',
    ]);
    expect([...setModes].sort()).toEqual(['merge', 'mergeFields', 'replace']);
    expect([...dbs].sort()).toEqual([0, 1, 2]);
    expect(whereOps.size).toBe(10);
    expect(txnScripts.size).toBe(6);
    expect(sawCompositeFilter).toBe(true);
    expect(sawSnapshotCursor).toBe(true);
    expect(sawValueCursor).toBe(true);
    expect(sawLimitToLast).toBe(true);
    expect(sawArrayValuedInCandidate).toBe(true);
    expect(sawArrayValuedNotInCandidate).toBe(true);
  });
});
