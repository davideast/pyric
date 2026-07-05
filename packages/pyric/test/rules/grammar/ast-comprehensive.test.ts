/**
 * Comprehensive AST tests — converted from bug bash (191 assertions).
 * Tests every AST node type, production rules, edge cases, and consistency.
 */
import { describe, test, expect } from 'bun:test';
import { parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { Expression } from '../../../src/rules/grammar/FirestoreAST.js';

const CORPUS = join(import.meta.dir, '../corpus');
function loadCorpus(path: string): string {
  return readFileSync(join(CORPUS, path), 'utf-8');
}

function parseExpr(input: string): Expression | null {
  const file = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /t/{d} { allow read: if ${input}; }
  }
}`;
  const ast = parseToAST(file);
  return ast?.service.match.children[0]?.allows[0]?.condition ?? null;
}

function containsNodeType(expr: Expression, type: string): boolean {
  if (expr.type === type) return true;
  if (expr.type === 'binaryOp') return containsNodeType(expr.left, type) || containsNodeType(expr.right, type);
  if (expr.type === 'unaryOp') return containsNodeType(expr.operand, type);
  if (expr.type === 'methodCall') return containsNodeType(expr.object, type) || expr.args.some(a => containsNodeType(a, type));
  if (expr.type === 'functionCall') return expr.args.some(a => containsNodeType(a, type));
  if (expr.type === 'ternary') return containsNodeType(expr.condition, type) || containsNodeType(expr.consequent, type) || containsNodeType(expr.alternate, type);
  return false;
}

describe('AST Comprehensive', () => {
  describe('expression literals', () => {
    test('true', () => { const e = parseExpr('true'); expect(e?.type).toBe('literal'); expect((e as any).value).toBe(true); });
    test('false', () => { const e = parseExpr('false'); expect((e as any).value).toBe(false); });
    test('null', () => { const e = parseExpr('null'); expect((e as any).value).toBe(null); });
    test('int', () => { const e = parseExpr('42'); expect((e as any).value).toBe(42); });
    test('float', () => { const e = parseExpr('3.14'); expect((e as any).value).toBe(3.14); });
    test('string', () => { const e = parseExpr("'hello'"); expect((e as any).value).toBe('hello'); });
  });

  describe('identifiers with keyword prefixes', () => {
    test('isAdmin', () => { const e = parseExpr('isAdmin'); expect(e?.type).toBe('identifier'); expect((e as any).name).toBe('isAdmin'); });
    test('internal', () => { const e = parseExpr('internal'); expect(e?.type).toBe('identifier'); });
  });

  describe('binary operators', () => {
    for (const [op, input] of [['==', 'a == b'], ['!=', 'a != b'], ['&&', 'a && b'], ['||', 'a || b'], ['>', 'a > b'], ['>=', 'a >= b'], ['<', 'a < b'], ['<=', 'a <= b'], ['+', 'a + b'], ['-', 'a - b'], ['*', 'a * b'], ['/', 'a / b'], ['%', 'a % b']]) {
      test(op, () => { const e = parseExpr(input); expect(e?.type).toBe('binaryOp'); expect((e as any).op).toBe(op); });
    }
  });

  describe('operator precedence in AST', () => {
    test('+ wraps * (lower precedence at top)', () => {
      const e = parseExpr('a + b * c');
      expect(e?.type).toBe('binaryOp'); expect((e as any).op).toBe('+');
      expect((e as any).right.type).toBe('binaryOp'); expect((e as any).right.op).toBe('*');
    });
    test('|| wraps && (lower precedence at top)', () => {
      const e = parseExpr('a || b && c');
      expect(e?.type).toBe('binaryOp'); expect((e as any).op).toBe('||');
      expect((e as any).right.op).toBe('&&');
    });
  });

  describe('unary operators', () => {
    test('!', () => { const e = parseExpr('!a'); expect(e?.type).toBe('unaryOp'); expect((e as any).op).toBe('!'); });
    test('-', () => { const e = parseExpr('-a'); expect(e?.type).toBe('unaryOp'); expect((e as any).op).toBe('-'); });
    test('!! nested', () => { const e = parseExpr('!!a'); expect(e?.type).toBe('unaryOp'); expect((e as any).operand.type).toBe('unaryOp'); });
  });

  describe('ternary', () => {
    test('structure', () => {
      const e = parseExpr('a ? b : c');
      expect(e?.type).toBe('ternary');
      expect((e as any).condition.type).toBe('identifier');
      expect((e as any).consequent.type).toBe('identifier');
      expect((e as any).alternate.type).toBe('identifier');
    });
  });

  describe('member access', () => {
    test('single', () => { const e = parseExpr('request.auth'); expect(e?.type).toBe('memberAccess'); expect((e as any).property).toBe('auth'); });
    test('deep chain', () => {
      const e = parseExpr('request.auth.uid');
      expect(e?.type).toBe('memberAccess'); expect((e as any).property).toBe('uid');
      expect((e as any).object.type).toBe('memberAccess');
    });
  });

  describe('method calls', () => {
    test('no args', () => { const e = parseExpr('data.size()'); expect(e?.type).toBe('methodCall'); expect((e as any).args.length).toBe(0); });
    test('with args', () => { const e = parseExpr("data.get('key', null)"); expect((e as any).args.length).toBe(2); });
    test('chained', () => {
      const e = parseExpr("data.keys().hasAll(['a'])");
      expect(e?.type).toBe('methodCall'); expect((e as any).method).toBe('hasAll');
      expect((e as any).object.type).toBe('methodCall');
    });
  });

  describe('bracket access', () => {
    test('string key', () => { const e = parseExpr("data['field']"); expect(e?.type).toBe('bracketAccess'); });
  });

  describe('in operator', () => {
    test('string in map', () => { const e = parseExpr("'key' in data"); expect(e?.type).toBe('inExpr'); });
  });

  describe('is operator', () => {
    for (const t of ['string', 'int', 'float', 'number', 'bool', 'list', 'map', 'timestamp', 'path', 'bytes', 'duration']) {
      test(`is ${t}`, () => { const e = parseExpr(`x is ${t}`); expect(e?.type).toBe('isExpr'); expect((e as any).typeName).toBe(t); });
    }
  });

  describe('list and map literals', () => {
    test('list', () => { const e = parseExpr('[1, 2, 3]'); expect(e?.type).toBe('listLiteral'); expect((e as any).elements.length).toBe(3); });
    test('empty list', () => { const e = parseExpr('[]'); expect((e as any).elements.length).toBe(0); });
    test('map', () => { const e = parseExpr('{a: 1, b: 2}'); expect(e?.type).toBe('mapLiteral'); expect((e as any).entries.length).toBe(2); });
  });

  describe('path literals', () => {
    test('with interpolation', () => {
      const e = parseExpr('/databases/$(database)/documents/users/$(uid)');
      expect(e?.type).toBe('pathLiteral');
      const interpolated = (e as any).segments.filter((s: any) => typeof s !== 'string');
      expect(interpolated.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('function calls', () => {
    test('debug()', () => { const e = parseExpr('debug(request.auth)'); expect(e?.type).toBe('functionCall'); expect((e as any).name).toBe('debug'); });
    test('math.abs (namespaced)', () => { const e = parseExpr('math.abs(-5)'); expect(e?.type).toBe('methodCall'); expect((e as any).method).toBe('abs'); });
  });

  describe('structure: paths and wildcards', () => {
    test('recursive wildcard', () => {
      const ast = parseToAST(loadCorpus('valid/002-allow-all.rules'))!;
      expect(ast.service.match.children[0].path.segments[0]).toEqual({ type: 'recursive', name: 'document' });
    });
    test('single wildcard', () => {
      const ast = parseToAST(loadCorpus('valid/004-all-operation-types.rules'))!;
      expect(ast.service.match.children[0].path.segments[1]).toEqual({ type: 'wildcard', name: 'itemId' });
    });
  });

  describe('structure: operations', () => {
    test('all 7 operation types', () => {
      const ast = parseToAST(loadCorpus('valid/004-all-operation-types.rules'))!;
      const ops = ast.service.match.children[0].allows.map(a => a.operations).flat();
      for (const op of ['read', 'write', 'get', 'list', 'create', 'update', 'delete'] as const) {
        expect(ops).toContain(op);
      }
    });
    test('combined operations', () => {
      const ast = parseToAST(loadCorpus('valid/005-combined-operations.rules'))!;
      const rw = ast.service.match.children[0].allows.find(a => a.operations.includes('read') && a.operations.includes('write'));
      expect(rw).toBeDefined();
    });
  });

  describe('structure: functions', () => {
    test('parameter counts', () => {
      const ast = parseToAST(loadCorpus('valid/008-functions.rules'))!;
      const fns = ast.service.match.functions;
      expect(fns.find(f => f.name === 'isAuthenticated')!.parameters.length).toBe(0);
      expect(fns.find(f => f.name === 'isOwner')!.parameters).toEqual(['userId']);
      expect(fns.find(f => f.name === 'hasRole')!.parameters).toEqual(['userId', 'role']);
    });
    test('scoped functions', () => {
      const ast = parseToAST(loadCorpus('edge-cases/003-scoped-functions.rules'))!;
      expect(ast.service.match.functions.some(f => f.name === 'isAuthenticated')).toBe(true);
      const teamA = ast.service.match.children.find(c => c.path.raw.includes('teamA'));
      expect(teamA!.functions[0].name).toBe('isTeamAMember');
    });
  });

  describe('structure: nesting', () => {
    test('3 levels deep', () => {
      const ast = parseToAST(loadCorpus('valid/009-nested-match.rules'))!;
      const teams = ast.service.match.children[0];
      expect(teams.children.length).toBe(2);
      const projects = teams.children.find(c => c.path.raw.includes('projects'));
      expect(projects!.children.length).toBe(1);
    });
  });

  describe('production rules (blockingfun)', () => {
    const prod = parseToAST(loadCorpus('valid/021-production-blockingfun.rules'))!;

    test('version and service', () => {
      expect(prod.version).toBe('2');
      expect(prod.service.name).toBe('cloud.firestore');
    });

    test('all 11 functions', () => {
      const names = prod.service.match.functions.map(f => f.name);
      for (const n of ['isAuthenticated', 'isOwner', 'isAdmin', 'isValidEmail', 'isValidUrl', 'hasOnlyAllowedFields', 'hasRequiredFields', 'isValidUser', 'isValidMarathon', 'isValidArticle', 'isValidLike']) {
        expect(names).toContain(n);
      }
    });

    test('isAdmin body has get() call', () => {
      const isAdmin = prod.service.match.functions.find(f => f.name === 'isAdmin');
      expect(containsNodeType(isAdmin!.body, 'functionCall')).toBe(true);
    });

    test('match blocks', () => {
      const paths = prod.service.match.children.map(m => m.path.raw);
      expect(paths.some(p => p.includes('users'))).toBe(true);
      expect(paths.some(p => p.includes('marathons'))).toBe(true);
      expect(paths.some(p => p.includes('likes'))).toBe(true);
    });

    test('marathons has nested articles', () => {
      const marathons = prod.service.match.children.find(m => m.path.raw.includes('marathons'));
      expect(marathons!.children[0].path.raw).toContain('articles');
    });

    test('users has CRUD operations', () => {
      const users = prod.service.match.children.find(m => m.path.raw.includes('users'));
      const ops = users!.allows.map(a => a.operations).flat();
      expect(ops).toContain('read');
      expect(ops).toContain('create');
      expect(ops).toContain('update');
      expect(ops).toContain('delete');
    });

    test('likes create has string concatenation', () => {
      const likes = prod.service.match.children.find(m => m.path.raw.includes('likes'));
      const create = likes!.allows.find(a => a.operations.includes('create'));
      expect(containsNodeType(create!.condition, 'binaryOp')).toBe(true);
    });
  });

  describe('all corpus files produce AST', () => {
    for (const dir of ['valid', 'edge-cases']) {
      const files = readdirSync(join(CORPUS, dir)).filter(f => f.endsWith('.rules')).sort();
      for (const file of files) {
        test(`${dir}/${file}`, () => {
          const content = readFileSync(join(CORPUS, dir, file), 'utf-8');
          expect(parseToAST(content)).not.toBeNull();
        });
      }
    }
  });

  describe('consistency', () => {
    test('double parse produces same structure', () => {
      const content = loadCorpus('valid/020-complex-real-world.rules');
      const a = parseToAST(content)!;
      const b = parseToAST(content)!;
      expect(a.version).toBe(b.version);
      expect(a.service.match.functions.length).toBe(b.service.match.functions.length);
      expect(a.service.match.children.length).toBe(b.service.match.children.length);
    });

    test('whitespace variation produces equivalent AST', () => {
      const compact = `rules_version='2';service cloud.firestore{match /databases/{database}/documents{match /t/{d}{allow read:if true;}}}`;
      const spacious = `rules_version = '2' ;\n  service   cloud.firestore   {\n    match   /databases/{database}/documents   {\n      match   /t/{d}   {\n        allow   read :   if   true ;\n      }\n    }\n  }`;
      const a = parseToAST(compact)!;
      const b = parseToAST(spacious)!;
      expect(a.version).toBe(b.version);
      expect(a.service.match.children.length).toBe(b.service.match.children.length);
      expect(a.service.match.children[0].allows[0].condition.type).toBe(b.service.match.children[0].allows[0].condition.type);
    });
  });
});
