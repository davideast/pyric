import { describe, expect, test } from 'bun:test';
import {
  proveListQuery,
  renderQueryRemediation,
  type ListProofVerdict,
} from '../../../src/firestore/sandbox/list-query-proof.js';
import { parseToAST } from '@pyric/rules/internal';
import { SimulateFirestoreRulesHandler } from '@pyric/rules/internal';

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

  // FS-ENF-4a/4b/4c: single-element `in`, intersected duplicate-field filters,
  // and contradictory filters.
  // Evidence: firebase.google.com/docs/firestore/security/rules-query and
  // deployed Firestore probe (FS-ENF-4c: rule `a == 1 && a == 2` with
  // `where('a', '==', 1), where('a', '==', 2)` is ALLOWED with 0 docs).
  test('populates syntheticResource from singleton in and intersected same-field filters (FS-ENF-4a, FS-ENF-4b)', () => {
    const fromSingleIn = expectProvable(prove(`match /items/{id} {
      allow list: if resource.data.status == 'open';
    }`, {
      where: [{ field: 'status', op: 'in', value: ['open'] }],
    }));
    expect(fromSingleIn.syntheticResource).toEqual({ status: 'open' });

    const inThenEq = expectProvable(prove(`match /items/{id} {
      allow list: if resource.data.status == 'open';
    }`, {
      where: [
        { field: 'status', op: 'in', value: ['open', 'closed'] },
        { field: 'status', op: '==', value: 'open' },
      ],
    }));
    expect(inThenEq.syntheticResource).toEqual({ status: 'open' });

    const eqThenIn = expectProvable(prove(`match /items/{id} {
      allow list: if resource.data.status == 'open';
    }`, {
      where: [
        { field: 'status', op: '==', value: 'open' },
        { field: 'status', op: 'in', value: ['open', 'closed'] },
      ],
    }));
    expect(eqThenIn.syntheticResource).toEqual({ status: 'open' });
  });

  test('resolves doc-independent user helper calls and bound parent path wildcards in static list query operands', () => {
    const ast = rules(
      `match /items/{id} {
        allow list: if currentUid() in resource.data.members
                    && resource.data.tags.hasAny([currentUid(), requiredTag()])
                    && resource.data.status in [requiredTag()];
      }
      match /orgs/{orgId}/items/{id} {
        allow list: if orgId in resource.data.orgIds && resource.data.orgId == orgId;
      }`,
      `function currentUid() { return request.auth.uid; }
       function requiredTag() { return 'public'; }`,
    );

    expectProvable(
      proveListQuery(ast, 'items/__listPlaceholder__', { uid: 'u1' }, {
        where: [
          { field: 'members', op: 'array-contains', value: 'u1' },
          { field: 'tags', op: 'array-contains', value: 'u1' },
          { field: 'status', op: '==', value: 'public' },
        ],
      }),
    );

    expectProvable(
      proveListQuery(ast, 'orgs/org-1/items/__listPlaceholder__', { uid: 'u1' }, {
        where: [
          { field: 'orgIds', op: 'array-contains', value: 'org-1' },
          { field: 'orgId', op: '==', value: 'org-1' },
        ],
      }),
    );
  });

  test('does not treat recursive parent path variables as string equalities', () => {
    const ast = parseToAST(`rules_version = '2';
      service cloud.firestore {
        match /databases/{prefix=**}/documents {
          match /items/{id} {
            allow list: if prefix in resource.data.parents;
          }
        }
      }`)!;

    const verdict = proveListQuery(ast, 'items/__listPlaceholder__', { uid: 'u1' }, {
      where: [{ field: 'parents', op: 'array-contains', value: '(default)' }],
    });
    expect(verdict.kind).toBe('unprovable');

    const eqAst = parseToAST(`rules_version = '2';
      service cloud.firestore {
        match /databases/{prefix=**}/documents {
          match /items/{id} {
            allow list: if resource.data.parent == prefix;
          }
        }
      }`)!;

    const contradictoryVerdict = proveListQuery(eqAst, 'items/__listPlaceholder__', { uid: 'u1' }, {
      where: [
        { field: 'parent', op: '==', value: '(default)' },
        { field: 'parent', op: '==', value: 'other' },
      ],
    });
    expect(contradictoryVerdict.kind).toBe('unprovable');
    if (contradictoryVerdict.kind === 'unprovable') {
      expect(contradictoryVerdict.failures[0]?.kind).toBe('unsupported-predicate');
    }
  });

  test('fails closed instead of falling back across lexical scopes when helper inlining exceeds budget', () => {
    const nineLets = [
      "let a0 = resource.data.secret == 's';",
      'let a1 = a0 && a0;',
      'let a2 = a1 && a1;',
      'let a3 = a2 && a2;',
      'let a4 = a3 && a3;',
      'let a5 = a4 && a4;',
      'let a6 = a5 && a5;',
      'let a7 = a6 && a6;',
      'let a8 = a7 && a7;',
    ].join('\n');

    const argScopeAst = parseToAST(`rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          function helper() { return true; }
          function passthrough(flag) { return resource.data.owner == 'u1' && flag; }
          match /items/{id} {
            function helper() {
              ${nineLets}
              return a8;
            }
            allow list: if passthrough(helper());
          }
        }
      }`)!;

    const argVerdict = proveListQuery(argScopeAst, 'items/__listPlaceholder__', { uid: 'u1' }, {
      where: [{ field: 'owner', op: '==', value: 'u1' }],
    });
    expect(argVerdict.kind).toBe('unprovable');

    const leafScopeAst = parseToAST(`rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          function bigSecret() {
            ${nineLets}
            return a8;
          }
          function checkOwnerAndSecret() {
            return resource.data.owner == 'u1' && bigSecret();
          }
          match /items/{id} {
            function bigSecret() { return true; }
            allow list: if checkOwnerAndSecret();
          }
        }
      }`)!;

    const leafVerdict = proveListQuery(leafScopeAst, 'items/__listPlaceholder__', { uid: 'u1' }, {
      where: [{ field: 'owner', op: '==', value: 'u1' }],
    });
    expect(leafVerdict.kind).toBe('unprovable');
  });

  test('tracks active callees by FunctionDef identity when an inner helper delegates to an outer helper of the same name', () => {
    const eqShadowAst = parseToAST(`rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          function helper() { return resource.data.owner == 'u1'; }
          function mid() { return helper(); }
          match /items/{id} {
            function helper() { return mid(); }
            allow list: if helper();
          }
        }
      }`)!;

    expectProvable(
      proveListQuery(eqShadowAst, 'items/__listPlaceholder__', { uid: 'u1' }, {
        where: [{ field: 'owner', op: '==', value: 'u1' }],
      }),
    );

    const residualShadowAst = parseToAST(`rules_version = '2';
      service cloud.firestore {
        match /databases/{database}/documents {
          function helper() {
            return resource.data.owner == 'u1' || resource.data.owner == 'u2';
          }
          function mid() { return helper(); }
          match /items/{id} {
            function helper() { return mid(); }
            allow list: if helper();
          }
        }
      }`)!;

    expectProvable(
      proveListQuery(residualShadowAst, 'items/__listPlaceholder__', { uid: 'u1' }, {
        where: [{ field: 'owner', op: 'in', value: ['u1', 'u2'] }],
      }),
    );
  });

  test('evaluates get and list across all top-level match blocks in service cloud.firestore', () => {
    const twoRootsSource = `rules_version = '2';
      service cloud.firestore {
        match /databases/{db}/documents {
          function firstRootHelper() { return false; }
          match /users/{uid} {
            allow read: if firstRootHelper();
          }
        }
        match /databases/{db}/documents {
          function secondRootOwner() { return request.auth.uid; }
          match /items/{id} {
            allow read: if request.auth != null && resource.data.owner == secondRootOwner();
          }
        }
      }`;
    const ast = parseToAST(twoRootsSource)!;

    expectProvable(
      proveListQuery(ast, 'items/__listPlaceholder__', { uid: 'u1' }, {
        where: [{ field: 'owner', op: '==', value: 'u1' }],
      }),
    );

    const handler = new SimulateFirestoreRulesHandler();
    const sim = handler.simulate(twoRootsSource, [
      {
        description: 'get item from second root block',
        expectation: 'ALLOW',
        method: 'get',
        path: 'items/i1',
        auth: { uid: 'u1' },
        resource: { owner: 'u1' },
      },
      {
        description: 'list items from second root block with matching where',
        expectation: 'ALLOW',
        method: 'list',
        path: 'items',
        auth: { uid: 'u1' },
        query: { where: [{ field: 'owner', op: '==', value: 'u1' }] },
      },
    ]);
    expect(sim.success).toBe(true);
    if (sim.success) {
      expect(sim.data.results.map((r) => r.decision)).toEqual(['ALLOW', 'ALLOW']);
      expect(sim.data.results[1]?.queryProof?.verdict).toBe('PROVABLE');
    }
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
