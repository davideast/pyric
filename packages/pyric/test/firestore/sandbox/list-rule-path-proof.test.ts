import { describe, expect, test } from 'bun:test';
import {
  analyzeListRulePathInvariance,
  buildListRuleFunctionScope,
} from '../../../src/firestore/sandbox/list-rule-path-proof.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';

function analyze(condition: string, helpers = '') {
  const ast = parseToAST(`rules_version = '2'; service cloud.firestore {
    match /databases/{database}/documents {
      match /items/{id} {
        ${helpers}
        allow list: if ${condition};
      }
    }
  }`)!;
  const block = ast.service.match.children[0]!;
  const functions = new Map(block.functions.map((fn) => [fn.name, fn]));
  return analyzeListRulePathInvariance(
    block.allows[0]!.condition,
    new Set(['id']),
    functions,
  );
}

describe('analyzeListRulePathInvariance', () => {
  test('accepts request fields that are stable for the whole query', () => {
    expect(analyze(`request.auth == null && request.method == 'list' &&
      request.query.limit == 10 && request.time != null`).pathInvariant).toBe(true);
  });

  test('rejects the candidate wildcard and direct request.path access', () => {
    expect(analyze("id == '__listPlaceholder__'").pathInvariant).toBe(false);
    expect(analyze("request.path.id == '__listPlaceholder__'").pathInvariant).toBe(false);
    expect(analyze("request['path'].id == '__listPlaceholder__'").pathInvariant).toBe(false);
  });

  test('follows reachable helpers and aliases of the candidate wildcard', () => {
    const result = analyze('isPlaceholder()', `
      function isPlaceholder() {
        let aliased = id;
        return aliased == '__listPlaceholder__';
      }
    `);

    expect(result.pathInvariant).toBe(false);
  });

  test('allows a helper parameter to shadow a candidate wildcard', () => {
    const result = analyze("isFixed('fixed')", `
      function isFixed(id) { return id == 'fixed'; }
    `);

    expect(result.pathInvariant).toBe(true);
    expect([...result.requiredFunctions]).toEqual(['isFixed']);
  });

  test('fails closed on recursive helper cycles', () => {
    const result = analyze('loops()', `
      function loops() { return loops(); }
    `);

    expect(result.pathInvariant).toBe(false);
  });

  test('fails closed when a reachable helper name is shadowed across scopes', () => {
    const ast = parseToAST(`rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents {
        function testPath() { return request.path.id == '__listPlaceholder__'; }
        function outer() { return testPath(); }
        match /items/{id} {
          function testPath() { return true; }
          allow list: if outer();
        }
      }
    }`)!;
    const block = ast.service.match.children[0]!;
    const scope = buildListRuleFunctionScope([
      ...ast.service.match.functions,
      ...block.functions,
    ]);

    const result = analyzeListRulePathInvariance(
      block.allows[0]!.condition,
      new Set(['id']),
      scope.functions,
      scope.ambiguousNames,
    );

    expect(result.pathInvariant).toBe(false);
  });

  test('does not reject rules that cannot reach a shadowed helper name', () => {
    const ast = parseToAST(`rules_version = '2'; service cloud.firestore {
      match /databases/{database}/documents {
        function unused() { return request.path.id == '__listPlaceholder__'; }
        function safe() { return true; }
        match /items/{id} {
          function unused() { return false; }
          allow list: if safe();
        }
      }
    }`)!;
    const block = ast.service.match.children[0]!;
    const scope = buildListRuleFunctionScope([
      ...ast.service.match.functions,
      ...block.functions,
    ]);

    const result = analyzeListRulePathInvariance(
      block.allows[0]!.condition,
      new Set(['id']),
      scope.functions,
      scope.ambiguousNames,
    );

    expect(result.pathInvariant).toBe(true);
    expect([...result.requiredFunctions]).toEqual(['safe']);
  });
});
