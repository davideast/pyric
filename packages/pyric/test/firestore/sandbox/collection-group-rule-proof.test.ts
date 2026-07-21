import { describe, expect, test } from 'bun:test';
import { proveGlobalCollectionGroupRules } from '../../../src/firestore/sandbox/collection-group-rule-proof.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';

function project(source: string) {
  return proveGlobalCollectionGroupRules(parseToAST(source));
}

function rules(children: string, outer = ''): string {
  return `rules_version = '2';
    ${outer}
    service cloud.firestore {
      match /databases/{database}/documents {
        ${children}
      }
    }`;
}

describe('proveGlobalCollectionGroupRules', () => {
  test('retains a safe allow while removing a path-dependent sibling', () => {
    const result = project(rules(`match /{document=**} {
      allow list: if true;
      allow list: if request.path.document == 'items/__listPlaceholder__';
    }`));

    expect(result?.service.match.children[0]?.allows).toHaveLength(1);
    expect(result?.service.match.children[0]?.allows[0]?.condition).toMatchObject({
      type: 'literal',
      value: true,
    });
  });

  test('removes an unused path-dependent helper', () => {
    const result = project(rules(`match /{document=**} {
      function unsafe() {
        return request.path.document == 'items/__listPlaceholder__';
      }
      allow list: if true;
    }`));

    expect(result?.service.match.children[0]?.functions).toEqual([]);
  });

  test('retains reachable path-invariant helpers at every enclosing scope', () => {
    const source = `rules_version = '2';
      function globalHelper() { return true; }
      service cloud.firestore {
        function serviceHelper() { return globalHelper(); }
        match /databases/{database}/documents {
          function rootHelper() { return serviceHelper(); }
          match /{document=**} {
            function blockHelper() { return rootHelper(); }
            allow list: if blockHelper();
          }
        }
      }`;

    const result = project(source)!;

    expect(result.functions?.map((fn) => fn.name)).toEqual(['globalHelper']);
    expect(result.service.functions?.map((fn) => fn.name)).toEqual(['serviceHelper']);
    expect(result.service.match.functions.map((fn) => fn.name)).toEqual(['rootHelper']);
    expect(result.service.match.children[0]?.functions.map((fn) => fn.name)).toEqual(['blockHelper']);
  });

  test('isolates a universal denial from an unrelated root-collection allow', () => {
    const result = project(rules(`
      match /items/{id} { allow list: if true; }
      match /{document=**} { allow list: if false; }
    `));

    expect(result?.service.match.children).toHaveLength(1);
    expect(result?.service.match.children[0]?.path.segments[0]).toMatchObject({
      type: 'recursive',
      name: 'document',
    });
  });

  test('rejects concrete-only and recursive-suffix rules', () => {
    expect(project(rules('match /items/{id} { allow list: if true; }'))).toBeNull();
    expect(project(rules('match /{path=**}/items/{id} { allow list: if true; }'))).toBeNull();
  });

  for (const condition of [
    "request.path.document == 'items/__listPlaceholder__'",
    "request['path'].document == 'items/__listPlaceholder__'",
    "document == 'items/__listPlaceholder__'",
  ]) {
    test(`rejects path-dependent condition: ${condition}`, () => {
      expect(project(rules(`match /{document=**} {
        allow list: if ${condition};
      }`))).toBeNull();
    });
  }

  test('rejects a reachable helper that aliases request before reading its path', () => {
    expect(project(rules(`match /{document=**} {
      function allowsSyntheticRoot() {
        let aliased = request;
        return aliased.path.document == 'items/__listPlaceholder__';
      }
      allow list: if allowsSyntheticRoot();
    }`))).toBeNull();
  });
});
