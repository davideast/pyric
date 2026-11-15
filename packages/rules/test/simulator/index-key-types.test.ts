import { describe, expect, test } from 'bun:test';
import { firestoreRules, storageRules } from '../../src/index.js';
import { IndexAccessFailure, indexValue } from '../../src/simulator/index-access.js';
import { Path } from '../../src/simulator/wrappers/path.js';
import { RulesFloat } from '../../src/simulator/wrappers/float.js';

function evalBoth(expr: string): {
  fs: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  st: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
} {
  const fsSource = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if ${expr};
    }
  }
}`;
  const stSource = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if ${expr};
    }
  }
}`;
  const fs = firestoreRules(fsSource).explain({
    description: expr,
    expectation: 'DENY',
    method: 'get',
    path: 'items/d1',
  }).decision;
  const st = storageRules(stSource, { bucket: 'demo-idx.appspot.com' }).explain({
    description: expr,
    expectation: 'DENY',
    method: 'get',
    path: 'items/d1',
    resource: { size: 1 },
  }).decision;
  return { fs, st };
}

describe('Map and Path bracket indexing key types', () => {
  test.each([
    ["map[int] fails instead of coercing to '1'", "{'1': 'ok'}[1] == 'ok'", 'DENY'],
    ["map[float] fails instead of coercing to '1.5'", "{'1.5': 'ok'}[1.5] == 'ok'", 'DENY'],
    ["map[bool] fails instead of coercing to 'true'", "{'true': 'ok'}[true] == 'ok'", 'DENY'],
    ["map[null] fails instead of coercing to 'null'", "{'null': 'ok'}[null] == 'ok'", 'DENY'],
    ["map[list] fails instead of coercing", "{'a': 'ok'}[['a']] == 'ok'", 'DENY'],
    ["map[map] fails instead of coercing", "{'[object Object]': 'ok'}[{'a': 1}] == 'ok'", 'DENY'],
    ["map[path] fails instead of coercing", "{'/items/d1': 'ok'}[path('/items/d1')] == 'ok'", 'DENY'],
    ["path[bool] fails instead of coercing to 'true'", "path('/items/{true}').bind({'true': 'ok'})[true] == 'ok'", 'DENY'],
    ["path[null] fails instead of coercing to 'null'", "path('/items/{null}').bind({'null': 'ok'})[null] == 'ok'", 'DENY'],
    ["path[float] fails instead of indexing segment", "path('/items/d1')[0.0] == 'items'", 'DENY'],
    ["path[non-integer float] fails", "path('/items/d1')[1.5] == 'd1'", 'DENY'],
    ["request.path[bool] fails", "request.path[true] == 'd1'", 'DENY'],
    ["request.path[null] fails", "request.path[null] == 'd1'", 'DENY'],
  ] as const)('Firestore and Storage reject non-string keys: %s', (_label, expr, expected) => {
    expect(evalBoth(expr)).toEqual({ fs: expected, st: expected });
  });

  test.each([
    ["negated map[int] equality stays an error (DENY)", "!({'1': 'ok'}[1] == 'other')", 'DENY'],
    ["map[int] inequality stays an error (DENY)", "{'1': 'ok'}[1] != 'other'", 'DENY'],
    ["map[int] error is absorbed by || true", "{'1': 'ok'}[1] == 'ok' || true", 'ALLOW'],
    ["map[int] error is absorbed by && false", "!({'1': 'ok'}[1] == 'ok' && false)", 'ALLOW'],
    ["negated path[bool] equality stays an error (DENY)", "!(path('/items/{true}').bind({'true': 'ok'})[true] == 'other')", 'DENY'],
    ["path[bool] inequality stays an error (DENY)", "path('/items/{true}').bind({'true': 'ok'})[true] != 'other'", 'DENY'],
    ["path[bool] error is absorbed by || true", "path('/items/{true}').bind({'true': 'ok'})[true] == 'ok' || true", 'ALLOW'],
    ["path[bool] error is absorbed by && false", "!(path('/items/{true}').bind({'true': 'ok'})[true] == 'ok' && false)", 'ALLOW'],
  ] as const)('Firestore and Storage error absorption: %s', (_label, expr, expected) => {
    expect(evalBoth(expr)).toEqual({ fs: expected, st: expected });
  });

  test.each([
    ["map[string] works", "{'1': 'ok'}['1'] == 'ok'", 'ALLOW'],
    ["path[int] 0-based segment lookup works", "path('/items/d1')[0] == 'items' && path('/items/d1')[1] == 'd1'", 'ALLOW'],
    ["path[string] bound name lookup works", "path('/items/{id}').bind({'id': 'd1'})['id'] == 'd1'", 'ALLOW'],
    ["path[int] out of bounds still errors", "path('/items/d1')[5] == 'x'", 'DENY'],
  ] as const)('Firestore and Storage valid key controls: %s', (_label, expr, expected) => {
    expect(evalBoth(expr)).toEqual({ fs: expected, st: expected });
  });

  test('request.path integer segment and Firestore wildcard indexing continue to work', () => {
    const fsDecision = firestoreRules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow get: if request.path[0] == 'databases' && request.path[3] == 'items' && request.path[4] == 'd1' && request.path['id'] == 'd1';
    }
  }
}`).explain({
      description: 'firestore request.path int indexing',
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/d1',
    }).decision;
    const stDecision = storageRules(`rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /items/{id} {
      allow get: if request.path[0] == 'b' && request.path[3] == 'items' && request.path[4] == 'd1';
    }
  }
}`, { bucket: 'demo-idx.appspot.com' }).explain({
      description: 'storage request.path int indexing',
      expectation: 'ALLOW',
      method: 'get',
      path: 'items/d1',
      resource: { size: 1 },
    }).decision;
    expect(fsDecision).toBe('ALLOW');
    expect(stDecision).toBe('ALLOW');
  });

  test('indexValue returns Unsupported operation error for non-string map keys and non-int/non-string path keys', () => {
    expect(indexValue({ '1': 'ok' }, 1n)).toEqual(
      new IndexAccessFailure('Unsupported operation error. Received: map[int]. Expected: map[string].'),
    );
    expect(indexValue({ true: 'ok' }, true)).toEqual(
      new IndexAccessFailure('Unsupported operation error. Received: map[bool]. Expected: map[string].'),
    );
    expect(indexValue({ null: 'ok' }, null)).toEqual(
      new IndexAccessFailure('Unsupported operation error. Received: map[null]. Expected: map[string].'),
    );

    const boundPath = new Path(['items', 'd1'], { id: 'd1', true: 'ok', null: 'ok' });
    expect(indexValue(boundPath, 0n)).toBe('items');
    expect(indexValue(boundPath, 'id')).toBe('d1');
    expect(indexValue(boundPath, true)).toEqual(
      new IndexAccessFailure('Unsupported operation error. Received: path[bool]. Expected: path[int], path[string].'),
    );
    expect(indexValue(boundPath, null)).toEqual(
      new IndexAccessFailure('Unsupported operation error. Received: path[null]. Expected: path[int], path[string].'),
    );
    expect(indexValue(boundPath, new RulesFloat(0))).toEqual(
      new IndexAccessFailure('Unsupported operation error. Received: path[float]. Expected: path[int], path[string].'),
    );
  });
});
