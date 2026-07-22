import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { sourceReceiverType } from '../../../src/rules/modules/source-expression-analysis.js';

describe('source expression analysis', () => {
  test('types Firestore document data returned by a source function as a map', () => {
    const ast = parseToAST(`rules_version = '2';
service firebase.storage {
  function membership() {
    return firestore.get(/databases/(default)/documents/members/alice).data;
  }
  match /b/{bucket}/o { match /{file} { allow read: if true; } }
}`);
    if (!ast) throw new Error('fixture failed to parse');
    const expression = ast.service.functions?.[0]?.body;
    if (!expression) throw new Error('fixture function missing');

    expect(sourceReceiverType(expression, {
      aliases: new Map(),
      receiverTypes: new Map(),
      functions: new Map(),
      service: 'firebase.storage',
      stack: new Set(),
    })).toBe('map');
  });
});
