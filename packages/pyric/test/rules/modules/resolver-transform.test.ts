import { describe, test, expect } from 'bun:test';
import {
  prefixPrivateFunctions,
  resolveModules,
  rewriteCalls,
  sanitizeModuleName,
} from '../../../src/rules/modules/resolver.js';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import type { Expression } from '../../../src/rules/grammar/FirestoreAST.js';

const makeSource = (imports: string, body: string = '') => `${imports}
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    ${body}
  }
}`;

// ---- Private function auto-prefixing ----

describe('sanitizeModuleName', () => {
  test('./admin → admin', () => expect(sanitizeModuleName('./admin')).toBe('admin'));
  test('./lib/helpers → lib_helpers', () => expect(sanitizeModuleName('./lib/helpers')).toBe('lib_helpers'));
  test('auth → auth', () => expect(sanitizeModuleName('auth')).toBe('auth'));
  test('../shared/utils → _shared_utils', () => expect(sanitizeModuleName('../shared/utils')).toBe('_shared_utils'));
});
describe('rewriteCalls', () => {
  const renames = new Map([['helper', 'mod__helper']]);
  const id = (name: string): Expression => ({ type: 'identifier', name });
  const call = (name: string, args: Expression[] = []): Expression => ({ type: 'functionCall', name, args });

  test('rewrites functionCall name in rename map', () => {
    const result = rewriteCalls(call('helper'), renames);
    expect(result.type).toBe('functionCall');
    if (result.type === 'functionCall') expect(result.name).toBe('mod__helper');
  });

  test('does not rewrite functionCall name NOT in rename map', () => {
    const result = rewriteCalls(call('other'), renames);
    if (result.type === 'functionCall') expect(result.name).toBe('other');
  });

  test('does not rewrite methodCall names', () => {
    const expr: Expression = { type: 'methodCall', object: id('data'), method: 'helper', args: [] };
    const result = rewriteCalls(expr, renames);
    if (result.type === 'methodCall') expect(result.method).toBe('helper');
  });

  test('rewrites nested calls', () => {
    const expr: Expression = { type: 'binaryOp', op: '&&', left: call('helper'), right: call('other') };
    const result = rewriteCalls(expr, renames);
    if (result.type === 'binaryOp') {
      if (result.left.type === 'functionCall') expect(result.left.name).toBe('mod__helper');
      if (result.right.type === 'functionCall') expect(result.right.name).toBe('other');
    }
  });

  test('returns original when rename map is empty', () => {
    const expr = call('helper');
    const result = rewriteCalls(expr, new Map());
    expect(result).toBe(expr); // same reference
  });

  test('rewrites calls inside slice bounds and objects', () => {
    const expr: Expression = {
      type: 'sliceAccess',
      object: call('helper'),
      start: call('helper'),
      end: call('other'),
    };
    const result = rewriteCalls(expr, renames);

    expect(result.type).toBe('sliceAccess');
    if (result.type === 'sliceAccess') {
      expect(result.object).toMatchObject({ type: 'functionCall', name: 'mod__helper' });
      expect(result.start).toMatchObject({ type: 'functionCall', name: 'mod__helper' });
      expect(result.end).toMatchObject({ type: 'functionCall', name: 'other' });
    }
  });

  test('rewrites calls inside interpolated path segments', () => {
    const expr: Expression = {
      type: 'pathLiteral',
      raw: '/documents/$(helper())',
      segments: ['documents', call('helper')],
    };
    const result = rewriteCalls(expr, renames);

    expect(result.type).toBe('pathLiteral');
    if (result.type === 'pathLiteral') {
      expect(result.segments[0]).toBe('documents');
      expect(result.segments[1]).toMatchObject({ type: 'functionCall', name: 'mod__helper' });
    }
  });
});

describe('prefixPrivateFunctions', () => {
  const mkFn = (name: string, exported: boolean, bodyCall?: string): import('../../../src/rules/grammar/FirestoreAST.js').FunctionDef => ({
    name, exported, parameters: [], lets: [],
    body: bodyCall
      ? { type: 'functionCall', name: bodyCall, args: [] }
      : { type: 'literal', value: true, raw: 'true' },
  });

  test('private function gets prefixed name', () => {
    const result = prefixPrivateFunctions([mkFn('helper', false)], './admin');
    expect(result[0].name).toBe('admin__helper');
  });

  test('exported function keeps original name', () => {
    const result = prefixPrivateFunctions([mkFn('pub', true)], './admin');
    expect(result[0].name).toBe('pub');
  });

  test('call sites in exported function rewritten to prefixed name', () => {
    const result = prefixPrivateFunctions([
      mkFn('pub', true, 'helper'),
      mkFn('helper', false),
    ], 'mymod');
    expect(result[0].name).toBe('pub');
    if (result[0].body.type === 'functionCall') {
      expect(result[0].body.name).toBe('mymod__helper');
    }
  });

  test('call sites in private function rewritten', () => {
    const result = prefixPrivateFunctions([
      mkFn('a', false, 'b'),
      mkFn('b', false),
    ], 'mod');
    if (result[0].body.type === 'functionCall') {
      expect(result[0].body.name).toBe('mod__b');
    }
  });

  test('module with no private functions returns unchanged', () => {
    const fns = [mkFn('pub', true)];
    const result = prefixPrivateFunctions(fns, 'mod');
    expect(result).toBe(fns); // same reference
  });
});

describe('bug bash: rewriteCalls edge cases', () => {
  const renames = new Map([['helper', 'mod__helper']]);
  const id = (name: string): Expression => ({ type: 'identifier', name });
  const call = (name: string, args: Expression[] = []): Expression => ({ type: 'functionCall', name, args });
  const lit = (v: boolean): Expression => ({ type: 'literal', value: v, raw: String(v) });

  test('rewrites in unary expression', () => {
    const expr: Expression = { type: 'unaryOp', op: '!', operand: call('helper') };
    const result = rewriteCalls(expr, renames);
    if (result.type === 'unaryOp' && result.operand.type === 'functionCall') {
      expect(result.operand.name).toBe('mod__helper');
    }
  });

  test('rewrites in list literal', () => {
    const expr: Expression = { type: 'listLiteral', elements: [call('helper')] };
    const result = rewriteCalls(expr, renames);
    if (result.type === 'listLiteral' && result.elements[0].type === 'functionCall') {
      expect(result.elements[0].name).toBe('mod__helper');
    }
  });

  test('does not rewrite identifiers', () => {
    const expr = id('helper');
    const result = rewriteCalls(expr, renames);
    expect(result).toBe(expr); // same reference — identifiers untouched
  });

  test('rewrites nested function call args', () => {
    const expr = call('outer', [call('helper')]);
    const result = rewriteCalls(expr, renames);
    if (result.type === 'functionCall') {
      expect(result.name).toBe('outer'); // outer not in renames
      if (result.args[0].type === 'functionCall') {
        expect(result.args[0].name).toBe('mod__helper');
      }
    }
  });
});

describe('bug bash: prefixing with let bindings and builtins', () => {
  const mkFn = (name: string, exported: boolean, bodyCall?: string, letCall?: string): import('../../../src/rules/grammar/FirestoreAST.js').FunctionDef => ({
    name, exported, parameters: [],
    lets: letCall ? [{ name: 'val', value: { type: 'functionCall', name: letCall, args: [] } }] : [],
    body: bodyCall
      ? { type: 'functionCall', name: bodyCall, args: [] }
      : { type: 'literal', value: true, raw: 'true' },
  });

  test('private function calling builtin get() — NOT prefixed', () => {
    const fns = [
      mkFn('helper', false, 'get'),
      mkFn('pub', true, 'helper'),
    ];
    const result = prefixPrivateFunctions(fns, 'mod');
    // helper's body calls get — should stay as 'get'
    if (result[0].body.type === 'functionCall') {
      expect(result[0].body.name).toBe('get');
    }
  });

  test('let binding call to private is rewritten', () => {
    const fns = [
      mkFn('priv', false),
      mkFn('pub', true, undefined, 'priv'),
    ];
    const result = prefixPrivateFunctions(fns, 'mod');
    // pub's let binding calls priv → should be mod__priv
    if (result[1].lets[0].value.type === 'functionCall') {
      expect(result[1].lets[0].value.name).toBe('mod__priv');
    }
  });
});

describe('end-to-end private collision resolution', () => {
  test('two modules with same private helper → different prefixed names', () => {
    const modA = `
      function helper() { return true; }
      export function fnA() { return helper(); }
    `;
    const modB = `
      function helper() { return false; }
      export function fnB() { return helper(); }
    `;
    const result = resolveModules(
      makeSource("import { fnA } from './modA';\nimport { fnB } from './modB';"),
      { modules: { './modA': modA, './modB': modB } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved).toContain('function modA__helper()');
      expect(result.data.resolved).toContain('function modB__helper()');
      // fnA calls modA's prefixed helper
      expect(result.data.resolved).toContain('modA__helper()');
      // fnB calls modB's prefixed helper
      expect(result.data.resolved).toContain('modB__helper()');
    }
  });

  test('exported functions keep original names in output', () => {
    const mod = `
      function priv() { return true; }
      export function pub() { return priv(); }
    `;
    const result = resolveModules(
      makeSource("import { pub } from './mod';"),
      { modules: { './mod': mod } },
    );
    if (result.success) {
      expect(result.data.resolved).toContain('function pub()');
      expect(result.data.resolved).toContain('function mod__priv()');
      expect(result.data.resolved).not.toContain('function priv()');
    }
  });

  test('three modules with same private name → all prefixed differently', () => {
    const mkMod = (pub: string) => `
      function helper() { return true; }
      export function ${pub}() { return helper(); }
    `;
    const result = resolveModules(
      makeSource("import { a } from './x';\nimport { b } from './y';\nimport { c } from './z';"),
      { modules: { './x': mkMod('a'), './y': mkMod('b'), './z': mkMod('c') } },
    );
    if (result.success) {
      expect(result.data.resolved).toContain('function x__helper()');
      expect(result.data.resolved).toContain('function y__helper()');
      expect(result.data.resolved).toContain('function z__helper()');
    }
  });

  test('output is parseable and passes validator', () => {
    const modA = `
      function check() { return true; }
      export function fnA() { return check() && request.auth != null; }
    `;
    const modB = `
      function check() { return false; }
      export function fnB() { return check() || request.auth != null; }
    `;
    const result = resolveModules(
      makeSource(
        "import { fnA } from './modA';\nimport { fnB } from './modB';",
        "match /items/{id} { allow read: if fnA() && fnB(); }",
      ),
      { modules: { './modA': modA, './modB': modB } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const ast = parseToAST(result.data.resolved);
      expect(ast).not.toBeNull();
      expect(ast!.version).toBe('2');
    }
  });
});
