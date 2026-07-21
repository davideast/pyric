import { describe, expect, test } from 'bun:test';
import {
  proveListQuery,
  renderQueryRemediation,
  type ListProofVerdict,
} from '../../../src/firestore/sandbox/list-query-proof.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';

function rules(children: string, outer = '') {
  return parseToAST(`rules_version = '2';
    ${outer}
    service cloud.firestore {
      match /databases/{database}/documents {
        ${children}
      }
    }`)!;
}

function prove(
  children: string,
  constraints: Parameters<typeof proveListQuery>[3] = {},
  outer = '',
) {
  return proveListQuery(
    rules(children, outer),
    'items/__listPlaceholder__',
    null,
    constraints,
  );
}

function expectProvable(verdict: ListProofVerdict) {
  expect(verdict.kind).toBe('provable');
  if (verdict.kind !== 'provable') throw new Error(`expected provable, got ${verdict.kind}`);
  return verdict;
}

describe('proveListQuery', () => {
  test('projects all matching blocks down to only their provable OR rules', () => {
    const verdict = expectProvable(prove(`
      match /items/{id} { allow list: if true; }
      match /{collection}/{id} {
        allow list: if resource.data.visibility == 'public';
      }
    `));

    expect(verdict.evaluationAst.service.match.children.map((block) => block.allows.length))
      .toEqual([1, 0]);
  });

  test('retains enclosing helper scopes needed by a provable rule', () => {
    const ast = parseToAST(`rules_version = '2';
      function globalHelper() { return true; }
      service cloud.firestore {
        function serviceHelper() { return globalHelper(); }
        match /databases/{database}/documents {
          function rootHelper() { return serviceHelper(); }
          match /items/{id} {
            function blockHelper() { return rootHelper(); }
            allow list: if blockHelper();
          }
        }
      }
    `)!;
    const verdict = expectProvable(proveListQuery(
      ast,
      'items/__listPlaceholder__',
      null,
      {},
    ));

    expect(verdict.evaluationAst.functions?.map((fn) => fn.name)).toEqual(['globalHelper']);
    expect(verdict.evaluationAst.service.functions?.map((fn) => fn.name))
      .toEqual(['serviceHelper']);
    expect(verdict.evaluationAst.service.match.functions.map((fn) => fn.name))
      .toEqual(['rootHelper']);
    expect(verdict.evaluationAst.service.match.children[0]?.functions.map((fn) => fn.name))
      .toEqual(['blockHelper']);
  });

  test('fails closed when a reachable helper name is shadowed', () => {
    const verdict = prove(`
      function unsafe() { return request.path.id == '__listPlaceholder__'; }
      function outer() { return unsafe(); }
      match /items/{id} {
        function unsafe() { return true; }
        allow list: if outer();
      }
    `);

    expect(verdict).toMatchObject({
      kind: 'unprovable',
      reason: 'list rule depends on the candidate document path',
    });
  });

  test('rejects candidate-document paths but permits fixed ancestor bindings', () => {
    expect(prove(`match /items/{id} {
      allow list: if id == '__listPlaceholder__';
    }`)).toMatchObject({ kind: 'unprovable' });

    const fixedAncestor = proveListQuery(
      rules(`match /users/{userId}/items/{id} {
        allow list: if userId == 'alice';
      }`),
      'users/alice/items/__listPlaceholder__',
      null,
      {},
    );
    expect(fixedAncestor.kind).toBe('provable');
  });

  test('builds the residual resource only from query-pinned equalities', () => {
    const verdict = expectProvable(prove(`match /items/{id} {
      allow list: if resource.data.visibility == 'public';
    }`, {
      where: [
        { field: 'visibility', op: '==', value: 'public' },
        { field: 'rank', op: '>=', value: 3 },
      ],
    }));

    expect(verdict.syntheticResource).toEqual({ visibility: 'public' });
  });
});

describe('renderQueryRemediation', () => {
  test('renders narrowing advice for missing and mismatched equalities', () => {
    const remediation = renderQueryRemediation({
      missing: [{
        field: 'owner',
        expectedValue: 'alice',
        fromAuthUid: true,
      }],
      mismatched: [{
        field: 'visibility',
        expectedValue: 'public',
        actualValue: 'private',
      }],
    });

    expect(remediation).toContain(".where('owner', '==', request.auth.uid)");
    expect(remediation).toContain(".where('visibility', '==', \"public\")");
    expect(remediation).toContain('the query pins "private"');
  });

  test('does not suggest an equality for an out-of-scope rule shape', () => {
    expect(renderQueryRemediation({
      missing: [],
      mismatched: [],
      outOfScope: 'disjunction',
    })).toBeUndefined();
  });
});
