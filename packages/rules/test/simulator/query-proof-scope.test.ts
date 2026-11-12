import { describe, expect, test } from 'bun:test';
import { assembleExpression } from '../../src/grammar/FirestoreAssembler.js';
import type { Expression, FunctionDef } from '../../src/grammar/FirestoreAST.js';
import { parseToAST } from '../../src/grammar/FirestoreParser.js';
import { indexRulesetScopes } from '../../src/simulator/match-resolution.js';
import {
  callsResolveInOuterScope,
  dataFieldPath,
  inlineFunctionsInExpr,
  inlineIfNeeded,
  isProvablyDocIndependent,
  isRequestAuthUid,
  isResourceData,
  referencesResourceData,
  substituteIdentifiers,
} from '../../src/simulator/query-proof-scope.js';

function parseCondition(ruleCondition: string): Expression {
  const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /items/{id} {
      allow list: if ${ruleCondition};
    }
  }
}`);
  if (!ast) throw new Error('failed to parse rules');
  return ast.service.match.children[0]!.allows[0]!.condition;
}

describe('query-proof-scope', () => {
  test('isResourceData and dataFieldPath recognize dot and bracket forms only on resource.data', () => {
    expect(isResourceData(parseCondition('resource.data'))).toBe(true);
    expect(isResourceData(parseCondition("resource['data']"))).toBe(true);
    expect(isResourceData(parseCondition('request.resource.data'))).toBe(false);
    const dotExpr = parseCondition('resource.data.orgId');
    const bracketExpr = parseCondition("resource['data']['orgId']");
    const nestedDotKey = parseCondition("resource.data['a.b']");
    const writeExpr = parseCondition('request.resource.data.orgId');

    expect(dataFieldPath(dotExpr)).toBe('orgId');
    expect(dataFieldPath(bracketExpr)).toBe('orgId');
    expect(dataFieldPath(nestedDotKey)).toBeNull();
    expect(dataFieldPath(writeExpr)).toBeNull();
  });

  test('isRequestAuthUid recognizes dot and bracket access on request.auth.uid', () => {
    expect(isRequestAuthUid(parseCondition('request.auth.uid'))).toBe(true);
    expect(isRequestAuthUid(parseCondition("request['auth']['uid']"))).toBe(true);
    expect(isRequestAuthUid(parseCondition('request.auth.token.uid'))).toBe(false);
    expect(isRequestAuthUid(parseCondition('resource.data.uid'))).toBe(false);
  });

  test('substituteIdentifiers replaces bound identifiers without mutating the source AST', () => {
    const expr = parseCondition('target == expected && items[idx] in [fallback]');
    const replacement = parseCondition("resource.data.orgId");
    const substituted = substituteIdentifiers(
      expr,
      new Map<string, Expression>([['target', replacement]]),
    );
    expect(assembleExpression(substituted)).toContain('resource.data.orgId');
    expect(assembleExpression(expr)).not.toContain('resource.data.orgId');
  });

  test('inlineFunctionsInExpr and inlineIfNeeded respect lexical helper scope over shadowed inner helpers', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function expectedOrg() { return 'org-main'; }
    function outerCheck() { return resource.data.orgId == expectedOrg(); }
    match /orgs/{orgId}/items/{id} {
      function expectedOrg() { return 'org-shadow'; }
      allow list: if outerCheck();
    }
  }
}`);
    if (!ast) throw new Error('failed to parse rules');
    indexRulesetScopes(ast);

    const rootFns = ast.service.match.functions;
    const innerBlock = ast.service.match.children[0]!;
    const innerFns = innerBlock.functions;
    const mergedScope = new Map<string, FunctionDef>();
    for (const fn of rootFns) mergedScope.set(fn.name, fn);
    for (const fn of innerFns) mergedScope.set(fn.name, fn);

    const callExpr = innerBlock.allows[0]!.condition;
    expect(inlineIfNeeded(callExpr, new Map())).toBe(callExpr);

    const inlined = inlineFunctionsInExpr(callExpr, mergedScope);
    expect(inlined).not.toBeNull();
    expect(assembleExpression(inlined!)).toBe("resource.data.orgId == 'org-main'");
  });

  test('callsResolveInOuterScope detects shadowed helper definitions across scopes', () => {
    const ast = parseToAST(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function roleTag() { return 'member'; }
    match /items/{id} {
      function roleTag() { return 'admin'; }
      allow list: if roleTag() == 'member';
    }
  }
}`);
    if (!ast) throw new Error('failed to parse rules');
    const rootScope = new Map<string, FunctionDef>(
      ast.service.match.functions.map((fn) => [fn.name, fn]),
    );
    const innerBlock = ast.service.match.children[0]!;
    const innerScope = new Map<string, FunctionDef>([
      ...rootScope,
      ...innerBlock.functions.map((fn): [string, FunctionDef] => [fn.name, fn]),
    ]);
    const cond = innerBlock.allows[0]!.condition;

    expect(callsResolveInOuterScope(cond, rootScope, rootScope)).toBe(true);
    expect(callsResolveInOuterScope(cond, rootScope, innerScope)).toBe(false);
  });

  test('referencesResourceData and isProvablyDocIndependent maintain opposite polarities', () => {
    const authOnly = parseCondition('request.auth != null');
    const docField = parseCondition("resource.data.status == 'active'");
    const docIdOnly = parseCondition("resource.id == 'doc-1'");

    expect(referencesResourceData(authOnly)).toBe(false);
    expect(isProvablyDocIndependent(authOnly)).toBe(true);

    expect(referencesResourceData(docField)).toBe(true);
    expect(isProvablyDocIndependent(docField)).toBe(false);

    expect(referencesResourceData(docIdOnly)).toBe(false);
    expect(isProvablyDocIndependent(docIdOnly)).toBe(false);
  });
});
