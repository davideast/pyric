import { describe, expect, test } from 'bun:test';
import type { Expression } from '../../../src/rules/grammar/FirestoreAST.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { methodReturnType } from '../../../src/rules/modules/receiver-types.js';

function expression(source: string): Expression {
  const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents/{doc=**} {
    allow read: if ${source};
  }
}`);
  return ast.service.match.allows[0]!.condition;
}

describe('rules method return types', () => {
  test.each([
    ["'A'.lower()", 'string'],
    ["'a,b'.split(',')", 'list'],
    ["{'owner': true}.keys()", 'set'],
    ["{'owner': true}.diff({})", 'mapdiff'],
    ["'A'.matches('A')", 'boolean'],
    ["'A'.size()", 'number'],
    ["hashing.sha256('A'.toUtf8())", 'bytes'],
    ["duration.value(1, 's')", 'duration'],
    ['latlng.value(1, 2)', 'latlng'],
    ['timestamp.date(2026, 1, 1)', 'timestamp'],
  ] as const)('%s returns %s', (source, expected) => {
    expect(methodReturnType(expression(source))).toBe(expected);
  });

  test('Map.get remains value-dependent', () => {
    expect(methodReturnType(expression("{'owner': true}.get('owner')"))).toBeNull();
  });
});
