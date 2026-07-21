import { describe, test, expect } from 'bun:test';
import { resolveModules, loadModule, sanitizeModuleName, rewriteCalls, prefixPrivateFunctions } from '../../../src/rules/modules/resolver.js';
import { parseFunctions, parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
import type { Expression } from '../../../src/rules/grammar/FirestoreAST.js';

// ---- Increment 3: Module loader + parseFunctions ----

describe('parseFunctions', () => {
  test('extracts functions from bare function text', () => {
    const fns = parseFunctions(`
      function isAuthenticated() {
        return request.auth != null;
      }
    `);
    expect(fns).not.toBeNull();
    expect(fns!).toHaveLength(1);
    expect(fns![0].name).toBe('isAuthenticated');
  });

  test('returns null on invalid syntax', () => {
    const fns = parseFunctions('this is not valid');
    expect(fns).toBeNull();
  });

  test('extracts multiple functions', () => {
    const fns = parseFunctions(`
      function a() { return true; }
      function b(x) { return x; }
    `);
    expect(fns!).toHaveLength(2);
    expect(fns![0].name).toBe('a');
    expect(fns![1].name).toBe('b');
  });

  test('preserves let bindings', () => {
    const fns = parseFunctions(`
      function check(uid) {
        let user = get(/databases/$(database)/documents/users/$(uid));
        let role = user.data.role;
        return role == 'admin';
      }
    `);
    expect(fns![0].lets).toHaveLength(2);
    expect(fns![0].lets[0].name).toBe('user');
    expect(fns![0].lets[1].name).toBe('role');
  });
});

describe('loadModule', () => {
  test('loads auth module', () => {
    const result = loadModule('auth');
    expect(result.success).toBe(true);
    if (result.success) {
      const names = result.functions.map(f => f.name);
      expect(names).toContain('isAuthenticated');
      expect(names).toContain('isOwner');
    }
  });

  test('loads validation module', () => {
    const result = loadModule('validation');
    expect(result.success).toBe(true);
    if (result.success) {
      const names = result.functions.map(f => f.name);
      expect(names).toContain('hasRequired');
      expect(names).toContain('hasOnly');
    }
  });

  test('unknown module returns UNKNOWN_MODULE', () => {
    const result = loadModule('nonexistent');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_MODULE');
  });

  test('auth module isOwner takes userId parameter', () => {
    const result = loadModule('auth');
    if (result.success) {
      const isOwner = result.functions.find(f => f.name === 'isOwner');
      expect(isOwner!.parameters).toEqual(['userId']);
    }
  });
});

// ---- Increment 4: Resolver ----

const makeSource = (imports: string, body: string = '') => `${imports}
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
    ${body}
  }
}`;

const makeStorageSource = (imports: string, condition: string) => `rules_version = '2+modules';
${imports}
service firebase.storage {
  match /b/{bucket}/o {
    match /{path=**} { allow read, write: if ${condition}; }
  }
}`;

describe('resolveModules', () => {
  test('resolves single module', () => {
    const result = resolveModules(makeSource("import { isAuthenticated } from 'auth';"));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved).toContain('function isAuthenticated()');
      expect(result.data.modules).toEqual(['auth']);
    }
  });

  test('resolves multiple modules', () => {
    const result = resolveModules(makeSource(
      "import { isOwner } from 'auth';\nimport { hasRequired } from 'validation';"
    ));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved).toContain('function isOwner');
      expect(result.data.resolved).toContain('function hasRequired');
      expect(result.data.modules).toContain('auth');
      expect(result.data.modules).toContain('validation');
    }
  });

  test('output version is 2', () => {
    const result = resolveModules(makeSource("import { isAuthenticated } from 'auth';"));
    if (result.success) {
      expect(result.data.resolved).toContain("rules_version = '2';");
      expect(result.data.resolved).not.toContain('2+modules');
    }
  });

  test('output is parseable by parseToAST', () => {
    const result = resolveModules(makeSource("import { isOwner } from 'auth';"));
    if (result.success) {
      const ast = parseToAST(result.data.resolved);
      expect(ast).not.toBeNull();
      expect(ast!.version).toBe('2');
    }
  });

  test('selective import: only requested functions + deps', () => {
    const result = resolveModules(makeSource("import { isAuthenticated } from 'auth';"));
    if (result.success) {
      expect(result.data.resolved).toContain('function isAuthenticated');
      expect(result.data.resolved).not.toContain('function isOwner');
    }
  });

  test('UNKNOWN_FUNCTION error', () => {
    const result = resolveModules(makeSource("import { nonexistent } from 'auth';"));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_FUNCTION');
  });

  test('UNKNOWN_MODULE error', () => {
    const result = resolveModules(makeSource("import { fn } from 'badmod';"));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_MODULE');
  });

  test('existing source functions preserved', () => {
    const result = resolveModules(makeSource(
      "import { isAuthenticated } from 'auth';",
      `function myHelper() { return true; }
       match /items/{id} { allow read: if myHelper() && isAuthenticated(); }`
    ));
    if (result.success) {
      expect(result.data.resolved).toContain('function isAuthenticated');
      expect(result.data.resolved).toContain('function myHelper');
    }
  });

  test('NOT_MODULE_SOURCE for standard version', () => {
    const result = resolveModules(`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
  }
}`);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_MODULE_SOURCE');
  });

  test('result includes list of modules used', () => {
    const result = resolveModules(makeSource(
      "import { isOwner } from 'auth';\nimport { hasRequired } from 'validation';"
    ));
    if (result.success) {
      expect(result.data.modules).toEqual(['auth', 'validation']);
    }
  });

  test('output has no import statements', () => {
    const result = resolveModules(makeSource("import { isOwner } from 'auth';"));
    if (result.success) {
      expect(result.data.resolved).not.toContain('import');
    }
  });
});

describe('service-aware module compatibility', () => {
  test('admits every production-probed common auth and membership export in Storage', () => {
    const result = resolveModules(makeStorageSource(
      `import { isAuthenticated, isOwner } from 'auth';
import { hasClaim, hasClaimRole, isMemberOf, hasRole } from 'membership';`,
      "isAuthenticated() && isOwner(request.auth.uid) && hasClaim('plan') && hasClaimRole('role', 'editor') && isMemberOf(request.auth.token.members) && hasRole(request.auth.token.members, 'editor')",
    ));

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modules).toEqual(['auth', 'membership']);
      expect(result.data.resolved).toContain("rules_version = '2';");
      expect(result.data.resolved).not.toContain('import ');
      const resolved = parseToAST(result.data.resolved);
      expect(resolved.service.name).toBe('firebase.storage');
      expect(resolved.service.match.functions.map((fn) => fn.name)).toEqual([
        'isAuthenticated',
        'isOwner',
        'hasClaim',
        'hasClaimRole',
        'isMemberOf',
        'hasRole',
      ]);
    }
  });

  test('rejects a Firestore-only stdlib export in Storage before emitting source', () => {
    const result = resolveModules(makeStorageSource(
      "import { immutableFields } from 'lifecycle';",
      "immutableFields(['owner'])",
    ));

    expect(result).toEqual({
      success: false,
      error: {
        code: 'INCOMPATIBLE_FUNCTION',
        message: "Function 'immutableFields' from module 'lifecycle' is not compatible with service 'firebase.storage'",
      },
    });
  });

  test('rejects an incompatible transitive private helper from a caller module', () => {
    const result = resolveModules(
      makeStorageSource("import { allowed } from './policy';", 'allowed()'),
      {
        modules: {
          './policy': `
            function firestoreDocumentOwner() {
              return resource.data.owner;
            }
            export function allowed() {
              return firestoreDocumentOwner() == request.auth.uid;
            }
          `,
        },
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
      expect(result.error.message).toContain('policy__firestoreDocumentOwner');
      expect(result.error.message).toContain("binding 'resource.data");
      expect(result.error.message).toContain("service 'firebase.storage'");
    }
  });

  test('rejects Storage-only ambient object fields from a Firestore caller module', () => {
    const result = resolveModules(
      makeSource("import { uploadIsSmall } from './policy';"),
      {
        modules: {
          './policy': `
            export function uploadIsSmall() {
              return request.resource.size < 1024;
            }
          `,
        },
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
      expect(result.error.message).toContain("binding 'request.resource.size'");
      expect(result.error.message).toContain("service 'cloud.firestore'");
    }
  });

  test('fails closed on an unclassified Storage ambient object field', () => {
    const result = resolveModules(
      makeStorageSource("import { hasDigest } from './policy';", 'hasDigest()'),
      {
        modules: {
          './policy': `
            export function hasDigest() {
              return request.resource.md5Hash != null;
            }
          `,
        },
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INCOMPATIBLE_FUNCTION');
      expect(result.error.message).toContain("binding 'request.resource.md5Hash'");
      expect(result.error.message).toContain("service 'firebase.storage'");
    }
  });
});

// ---- Increment 5: Transitive dependencies ----

describe('transitive dependencies', () => {
  test('import isOwner includes isAuthenticated', () => {
    const result = resolveModules(makeSource("import { isOwner } from 'auth';"));
    if (result.success) {
      expect(result.data.resolved).toContain('function isOwner');
      expect(result.data.resolved).toContain('function isAuthenticated');
    }
  });

  test('import isAuthenticated does not include isOwner', () => {
    const result = resolveModules(makeSource("import { isAuthenticated } from 'auth';"));
    if (result.success) {
      expect(result.data.resolved).toContain('function isAuthenticated');
      expect(result.data.resolved).not.toContain('function isOwner');
    }
  });

  test('explicit + transitive does not duplicate', () => {
    const result = resolveModules(makeSource("import { isAuthenticated, isOwner } from 'auth';"));
    if (result.success) {
      const matches = result.data.resolved.match(/function isAuthenticated/g);
      expect(matches).toHaveLength(1);
    }
  });

  test('transitive dep appears before dependent', () => {
    const result = resolveModules(makeSource("import { isOwner } from 'auth';"));
    if (result.success) {
      const authIdx = result.data.resolved.indexOf('function isAuthenticated');
      const ownerIdx = result.data.resolved.indexOf('function isOwner');
      expect(authIdx).toBeLessThan(ownerIdx);
    }
  });
});

// ---- Fuzz findings ----

describe('fuzz edge cases', () => {
  test('version 2+modules+extra is rejected (exact match)', () => {
    const source = `rules_version = '2+modules+extra';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
  }
}`;
    const result = resolveModules(source);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_MODULE_SOURCE');
  });

  test('imported function conflicting with source function → DUPLICATE_FUNCTION', () => {
    const result = resolveModules(makeSource(
      "import { isAuthenticated } from 'auth';",
      'function isAuthenticated() { return true; }\nmatch /x/{id} { allow read: if isAuthenticated(); }'
    ));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DUPLICATE_FUNCTION');
  });

  test('path traversal module name safely fails', () => {
    const result = resolveModules(makeSource("import { fn } from '../../etc/passwd';"));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_MODULE');
  });

  test('keyword as import function name is rejected by grammar', () => {
    const source = `import { true } from 'auth';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
  }
}`;
    const result = resolveModules(source);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('PARSE_FAILED');
  });

  test('double resolve returns NOT_MODULE_SOURCE', () => {
    const first = resolveModules(makeSource("import { isAuthenticated } from 'auth';"));
    expect(first.success).toBe(true);
    if (first.success) {
      const second = resolveModules(first.data.resolved);
      expect(second.success).toBe(false);
      if (!second.success) expect(second.error.code).toBe('NOT_MODULE_SOURCE');
    }
  });

  test('many functions in one import (stress)', () => {
    // Import both functions from auth — should handle fine
    const result = resolveModules(makeSource("import { isAuthenticated, isOwner } from 'auth';"));
    expect(result.success).toBe(true);
  });

  test('import with newlines inside braces', () => {
    const source = `import {
  isAuthenticated,
  isOwner
} from 'auth';
rules_version = '2+modules';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{d=**} { allow read, write: if false; }
  }
}`;
    const ast = parseToAST(source);
    expect(ast).not.toBeNull();
    expect(ast!.imports[0].functions).toEqual(['isAuthenticated', 'isOwner']);
  });
});

// ---- Export filtering + user modules ----

describe('export filtering', () => {
  test('stdlib auth functions are exported', () => {
    const result = loadModule('auth');
    expect(result.success).toBe(true);
    if (result.success) {
      for (const fn of result.functions) {
        expect(fn.exported).toBe(true);
      }
    }
  });

  test('stdlib validation functions are exported', () => {
    const result = loadModule('validation');
    expect(result.success).toBe(true);
    if (result.success) {
      for (const fn of result.functions) {
        expect(fn.exported).toBe(true);
      }
    }
  });

  test('user module: only exported functions are importable', () => {
    const userModule = `
      export function pub() { return true; }
      function priv() { return false; }
    `;
    const result = resolveModules(
      makeSource("import { pub } from './helpers';"),
      { modules: { './helpers': userModule } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved).toContain('function pub()');
      expect(result.data.resolved).not.toContain('function priv()');
    }
  });

  test('import non-exported function → UNKNOWN_FUNCTION', () => {
    const userModule = `
      export function pub() { return true; }
      function priv() { return false; }
    `;
    const result = resolveModules(
      makeSource("import { priv } from './helpers';"),
      { modules: { './helpers': userModule } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('UNKNOWN_FUNCTION');
      expect(result.error.message).toContain('not exported');
    }
  });

  test('exported function calling non-exported helper includes prefixed helper as transitive dep', () => {
    const userModule = `
      function checkDoc(uid) { return get(/databases/$(database)/documents/admins/$(uid)).data.active == true; }
      export function isAdmin() { return isAuthenticated() && checkDoc(request.auth.uid); }
    `;
    const result = resolveModules(
      makeSource("import { isAuthenticated } from 'auth';\nimport { isAdmin } from './helpers';"),
      { modules: { './helpers': userModule } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved).toContain('function isAdmin()');
      // checkDoc is private → prefixed with module name
      expect(result.data.resolved).toContain('function helpers__checkDoc(');
      // isAdmin's call site rewritten to prefixed name
      expect(result.data.resolved).toContain('helpers__checkDoc(');
      expect(result.data.resolved).toContain('function isAuthenticated()');
    }
  });
});

describe('user modules via options', () => {
  test('modules map provides content directly', () => {
    const result = resolveModules(
      makeSource("import { myFn } from './custom';"),
      { modules: { './custom': 'export function myFn() { return true; }' } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved).toContain('function myFn()');
    }
  });

  test('modules map takes priority over basePath', () => {
    const result = resolveModules(
      makeSource("import { myFn } from './custom';"),
      {
        modules: { './custom': 'export function myFn() { return true; }' },
        basePath: '/nonexistent/path',
      },
    );
    // modules map wins — basePath is never checked
    expect(result.success).toBe(true);
  });

  test('bare import still resolves from stdlib', () => {
    const result = resolveModules(
      makeSource("import { isAuthenticated } from 'auth';"),
      { modules: { './custom': 'export function myFn() { return true; }' } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resolved).toContain('function isAuthenticated()');
    }
  });

  test('diamond dependency: private copies get prefixed, exported stays clean', () => {
    const authMod = `
      export function isAuthenticated() { return request.auth != null; }
      export function isOwner(userId) { return isAuthenticated() && request.auth.uid == userId; }
    `;
    const adminMod = `
      function isAuthenticated() { return request.auth != null; }
      export function isAdmin() { return isAuthenticated() && get(/databases/$(database)/documents/admins/$(request.auth.uid)).data.active == true; }
    `;
    const result = resolveModules(
      makeSource("import { isOwner } from './auth';\nimport { isAdmin } from './admin';"),
      { modules: { './auth': authMod, './admin': adminMod } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      // auth's isAuthenticated is exported — keeps original name
      expect(result.data.resolved).toContain('function isAuthenticated()');
      // admin's isAuthenticated is private — gets prefixed
      expect(result.data.resolved).toContain('function admin__isAuthenticated()');
      // isAdmin calls the prefixed version
      expect(result.data.resolved).toContain('admin__isAuthenticated()');
      // Both exported functions present
      expect(result.data.resolved).toContain('function isOwner');
      expect(result.data.resolved).toContain('function isAdmin');
    }
  });

  test('circular dependency: A calls B, B calls A — both included once, no crash', () => {
    const modA = `
      export function fnA() { return fnB() && request.auth != null; }
      function fnB() { return fnA() || true; }
    `;
    const result = resolveModules(
      makeSource("import { fnA } from './modA';"),
      { modules: { './modA': modA } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      // fnA is exported (keeps name), fnB is private (gets prefixed)
      const countA = (result.data.resolved.match(/function fnA/g) || []).length;
      const countB = (result.data.resolved.match(/function modA__fnB/g) || []).length;
      expect(countA).toBe(1);
      expect(countB).toBe(1);
    }
  });

  test('let binding function calls are tracked as transitive deps', () => {
    const mod = `
      function helper() { return true; }
      export function main() {
        let val = helper();
        return val;
      }
    `;
    const result = resolveModules(
      makeSource("import { main } from './mod';"),
      { modules: { './mod': mod } },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      // helper is private so it gets prefixed, but still included
      expect(result.data.resolved).toContain('function mod__helper()');
      expect(result.data.resolved).toContain('function main()');
    }
  });

  test('dependency order: deps before dependents', () => {
    const mod = `
      function base() { return true; }
      export function mid() { return base(); }
      export function top() { return mid(); }
    `;
    const result = resolveModules(
      makeSource("import { top } from './mod';"),
      { modules: { './mod': mod } },
    );
    if (result.success) {
      const baseIdx = result.data.resolved.indexOf('function base');
      const midIdx = result.data.resolved.indexOf('function mid');
      const topIdx = result.data.resolved.indexOf('function top');
      expect(baseIdx).toBeLessThan(midIdx);
      expect(midIdx).toBeLessThan(topIdx);
    }
  });

  test('relative import without basePath or modules map → error', () => {
    const result = resolveModules(
      makeSource("import { myFn } from './helpers';"),
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_MODULE');
  });

  test('resolved output strips export keyword from injected functions', () => {
    const result = resolveModules(
      makeSource("import { myFn } from './custom';"),
      { modules: { './custom': 'export function myFn() { return true; }' } },
    );
    if (result.success) {
      expect(result.data.resolved).not.toContain('export function');
    }
  });
});

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
