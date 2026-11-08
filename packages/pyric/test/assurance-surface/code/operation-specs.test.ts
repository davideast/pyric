import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import {
  calleeName,
  FIRESTORE_OPS,
  isDocWrite,
  isWriteOp,
  RTDB_OPS,
  txMethodSpecs,
} from '../../../src/assurance-surface/code/operation-specs.js';
import { harness } from './harness.js';

describe('operation-specs', () => {
  test('isWriteOp and isDocWrite classify Firestore and RTDB operations', () => {
    expect(isWriteOp('setDoc')).toBe(true);
    expect(isWriteOp('addDoc')).toBe(true);
    expect(isWriteOp('onDisconnect.set')).toBe(true);
    expect(isWriteOp('remove')).toBe(true);
    expect(isWriteOp('get')).toBe(false);
    expect(isWriteOp('query')).toBe(false);

    expect(isDocWrite('setDoc')).toBe(true);
    expect(isDocWrite('updateDoc')).toBe(true);
    expect(isDocWrite('deleteDoc')).toBe(true);
    expect(isDocWrite('addDoc')).toBe(false);
  });

  test('txMethodSpecs maps transaction methods to Firestore and RTDB specs', () => {
    expect(txMethodSpecs('set')).toEqual({ firestore: FIRESTORE_OPS.setDoc, rtdb: RTDB_OPS.set });
    expect(txMethodSpecs('update')).toEqual({ firestore: FIRESTORE_OPS.updateDoc, rtdb: RTDB_OPS.update });
    expect(txMethodSpecs('delete')).toEqual({ firestore: FIRESTORE_OPS.deleteDoc, rtdb: RTDB_OPS.remove });
    expect(txMethodSpecs('get')).toEqual({ firestore: FIRESTORE_OPS.getDoc, rtdb: RTDB_OPS.get });
  });

  test('calleeName extracts direct identifier and member call names and returns undefined for computed calls', () => {
    const h = harness({
      'a.ts': `
        declare const obj: { save: () => void; list: (() => void)[] };
        declare function run(): void;
        run();
        obj.save();
        obj.list[0]();
      `,
    });
    expect(calleeName(h.expr('a.ts', 'run()') as ts.CallExpression)).toBe('run');
    expect(calleeName(h.expr('a.ts', 'obj.save()') as ts.CallExpression)).toBe('save');
    expect(calleeName(h.expr('a.ts', 'obj.list[0]()') as ts.CallExpression)).toBeUndefined();
  });
});
