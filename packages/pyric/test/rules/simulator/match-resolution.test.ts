import { describe, expect, test } from 'bun:test';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import {
  collectMatches,
  renderMatchBlockPath,
} from '../../../src/rules/simulator/match-resolution.js';
import type { PathResolutionEntry } from '../../../src/rules/test/spec.js';

function parse(children: string) {
  return parseToAST(`rules_version = '2';
    function globalHelper() { return true; }
    service cloud.firestore {
      function serviceHelper() { return globalHelper(); }
      match /databases/{database}/documents {
        function rootHelper() { return serviceHelper(); }
        ${children}
      }
    }`)!;
}

function resolve(children: string, path: string) {
  const ast = parse(children);
  const functions = [
    ...(ast.functions ?? []),
    ...(ast.service.functions ?? []),
    ...ast.service.match.functions,
  ];
  return ast.service.match.children.flatMap((block) =>
    collectMatches(block, path.split('/'), functions));
}

describe('collectMatches', () => {
  test('returns every overlapping match with independent bindings', () => {
    const matches = resolve(`
      match /items/{itemId} { allow read: if true; }
      match /{collection}/{docId} { allow read: if true; }
    `, 'items/a');

    expect(matches.map((match) => match.pathVariables)).toEqual([
      { itemId: 'a' },
      { collection: 'items', docId: 'a' },
    ]);
  });

  test('merges nested bindings and marks only the candidate document wildcard', () => {
    const [match] = resolve(`match /users/{userId} {
      function ancestorHelper() { return rootHelper(); }
      match /items/{itemId} {
        function itemHelper() { return ancestorHelper(); }
        allow read: if itemHelper();
      }
    }`, 'users/alice/items/a');

    expect(match?.pathVariables).toEqual({ userId: 'alice', itemId: 'a' });
    expect(match?.candidateVariables).toEqual(['itemId']);
    expect(match?.functions.map((fn) => fn.name)).toEqual([
      'globalHelper',
      'serviceHelper',
      'rootHelper',
      'ancestorHelper',
      'itemHelper',
    ]);
  });

  test('marks a recursive wildcard as candidate-dependent', () => {
    const [match] = resolve(`match /{document=**} {
      allow read: if true;
    }`, 'parents/a/items/b');

    expect(match?.pathVariables).toEqual({ document: 'parents/a/items/b' });
    expect(match?.candidateVariables).toEqual(['document']);
    expect(match && renderMatchBlockPath(match.block)).toBe('/{document=**}');
  });

  test('a recursive wildcard followed by segments matches zero or more leading segments', () => {
    const rule = 'match /{path=**}/items/{id} { allow read: if true; }';

    expect(resolve(rule, 'items/a').map((match) => match.pathVariables)).toEqual([{ path: '', id: 'a' }]);
    expect(resolve(rule, 'users/u1/items/a').map((match) => match.pathVariables))
      .toEqual([{ path: 'users/u1', id: 'a' }]);
    expect(resolve(rule, 'items/items/items/a').map((match) => match.pathVariables))
      .toEqual([{ path: 'items/items', id: 'a' }]);
    expect(resolve(rule, 'users/u1/items/a').map((match) => match.candidateVariables)).toEqual([['id']]);
    expect(resolve(rule, 'users/u1/other/a')).toEqual([]);
    expect(resolve(rule, 'users/u1/items/a/sub/b')).toEqual([]);
    expect(resolve(rule, 'users/u1')).toEqual([]);
  });

  test('a block whose recursive wildcard is followed by segments reaches no nested match', () => {
    const rule = `match /{group=**}/groups/{groupId} {
      match /members/{memberId} { allow get: if true; }
    }`;

    expect(resolve(rule, 'groups/g1/members/m1')).toEqual([]);
    expect(resolve(rule, 'orgs/o1/groups/g1/members/m1')).toEqual([]);
  });

  test('a final recursive wildcard lets a nested match continue at any depth, binding the longest prefix', () => {
    const rule = `match /{document=**} {
      allow read: if true;
      match /notes/{noteId} { allow get: if true; }
    }`;

    expect(resolve(rule, 'notes/n1').map((match) => match.pathVariables)).toEqual([
      { document: 'notes/n1' },
      { document: '', noteId: 'n1' },
    ]);
    expect(resolve(rule, 'notes/n1/notes/n2').map((match) => match.pathVariables)).toEqual([
      { document: 'notes/n1/notes/n2' },
      { document: 'notes/n1', noteId: 'n2' },
    ]);
    expect(resolve(rule, 'a/1/notes/n1')[1]?.candidateVariables).toEqual(['noteId']);
  });

  test('records literal near misses and unmatched child containers', () => {
    const ast = parse(`match /users/{userId} {
      match /items/{itemId} { allow read: if true; }
    }`);
    const attempts: PathResolutionEntry[] = [];
    const recorder = { push: (entry: PathResolutionEntry) => attempts.push(entry) };

    expect(collectMatches(
      ast.service.match.children[0]!,
      ['users', 'alice', 'other', 'a'],
      [],
      recorder,
    )).toEqual([]);
    expect(attempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ blockPath: '/items/{itemId}', reason: 'literal-mismatch' }),
      expect.objectContaining({ blockPath: '/users/{userId}', reason: 'no-matching-child' }),
    ]));
  });
});
