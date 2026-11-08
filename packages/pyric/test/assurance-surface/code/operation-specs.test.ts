import { describe, expect, test } from 'bun:test';
import ts from 'typescript';
import {
  buildOperationIndex,
  calleeName,
  isWriteOp,
} from '../../../src/assurance-surface/code/operation-specs.js';
import { DEFAULT_SERVICE_MODELS } from '../../../src/assurance-surface/code/sdk-imports.js';
import { FIRESTORE_SERVICE_MODEL } from '../../../src/assurance-surface/code/service-models/firestore.js';
import { RTDB_SERVICE_MODEL } from '../../../src/assurance-surface/code/service-models/rtdb.js';
import { harness } from './harness.js';

describe('operation-specs', () => {
  test('buildOperationIndex derives api names, receiver methods, transaction methods, and write ops from models', () => {
    const index = buildOperationIndex(DEFAULT_SERVICE_MODELS);
    expect(index.apiNames.has('setDoc')).toBe(true);
    expect(index.apiNames.has('collectionGroup')).toBe(true);
    expect(index.apiNames.has('refFromURL')).toBe(true);
    expect(index.methodNames.has('set')).toBe(true);
    expect(index.methodNames.has('remove')).toBe(true);

    expect(index.transactionMethods.get('set')).toEqual([
      { service: 'firestore', spec: FIRESTORE_SERVICE_MODEL.receiverMethods!.transaction!.set! },
      { service: 'rtdb', spec: RTDB_SERVICE_MODEL.receiverMethods!.transaction!.set! },
    ]);
    expect(index.transactionMethods.get('delete')).toEqual([
      { service: 'firestore', spec: FIRESTORE_SERVICE_MODEL.receiverMethods!.transaction!.delete! },
      { service: 'rtdb', spec: RTDB_SERVICE_MODEL.receiverMethods!.transaction!.delete! },
    ]);

    expect(isWriteOp('setDoc')).toBe(true);
    expect(isWriteOp('addDoc')).toBe(true);
    expect(isWriteOp('onDisconnect.set')).toBe(true);
    expect(isWriteOp('remove')).toBe(true);
    expect(isWriteOp('get')).toBe(false);
    expect(isWriteOp('query')).toBe(false);
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
