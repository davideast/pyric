import { describe, test, expect } from 'bun:test';
import { resolveModules, loadModule } from '../../../src/rules/modules/resolver.js';
import { parseFunctions, parseToAST } from '../../../src/rules/grammar/FirestoreParser.js';
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
      expect(result.data.evidenceIds).toEqual(['firestore-rules#189']);
    }
  });

  test('resolves the conventional stdlib path alias', () => {
    const result = resolveModules(makeSource("import { isAuthenticated } from './stdlib/auth.rules';"));
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
    if (result.success) {
      expect(result.data.bundledModules).toEqual(['./stdlib/auth.rules']);
      expect(result.data.evidenceIds).toEqual(['firestore-rules#189']);
    }
  });
  test('lets an explicit module override the conventional stdlib path alias', () => {
    const result = resolveModules(
      makeSource("import { callerPolicy } from './stdlib/auth.rules';"),
      { modules: { './stdlib/auth.rules': 'export function callerPolicy() { return true; }' } },
    );
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
    if (result.success) {
      expect(result.data.bundledModules).toEqual([]);
      expect(result.data.evidenceIds).toEqual([]);
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
    const unimported = resolveModules(
      makeStorageSource("import { foo } from './policy';", 'bar()'),
      { modules: { './policy': `
        export function foo() { return true; }
        export function bar() { return true; }
      ` } },
    );
    expect(unimported.success).toBe(false);
    if (!unimported.success) expect(unimported.error.code).toBe('UNKNOWN_FUNCTION');
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

  test('validates each requested export against its declared module', () => {
    const result = resolveModules(
      makeSource("import { foo } from './a';\nimport { foo } from './b';"),
      { modules: {
        './a': 'export function foo() { return true; }',
        './b': 'export function bar() { return true; }',
      } },
    );

    expect(result).toEqual({
      success: false,
      error: {
        code: 'UNKNOWN_FUNCTION',
        message: "Function 'foo' not found in module './b'",
      },
    });
  });

  test('rejects colliding private helper names from distinct module paths', () => {
    const result = resolveModules(
      makeStorageSource(
        "import { allowedA } from './a-b';\nimport { allowedB } from './a/b';",
        'allowedA() && allowedB()',
      ),
      { modules: {
        './a-b': `
          function helper() { return resource.data.owner == request.auth.uid; }
          export function allowedA() { return helper(); }
        `,
        './a/b': `
          function helper() { return true; }
          export function allowedB() { return helper(); }
        `,
      } },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DUPLICATE_FUNCTION');
      expect(result.error.message).toContain("'./a-b'");
      expect(result.error.message).toContain("'./a/b'");
      expect(result.error.message).toContain('a_b__helper');
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
      function checkDoc(uid) { return get(/databases/(default)/documents/admins/$(uid)).data.active == true; }
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
  test('ignores inherited module-map properties', () => {
    const modules = Object.create({
      './helpers': 'export function inherited() { return true; }',
    }) as Record<string, string>;
    const result = resolveModules(
      makeSource("import { inherited } from './helpers';"),
      { modules },
    );
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('UNKNOWN_MODULE');
  });

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
      export function isAdmin() { return isAuthenticated() && get(/databases/(default)/documents/admins/$(request.auth.uid)).data.active == true; }
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
  test.each([
    ['direct', `function loop() { return loop(); }
      export function broken() { return loop(); }`],
    ['mutual', `function a() { return b(); }
      function b() { return a(); }
      export function broken() { return a(); }`],
  ])('rejects %s recursive module helpers', (_kind, moduleSource) => {
    const result = resolveModules(
      makeSource("import { broken } from './policy';"),
      { modules: { './policy': moduleSource } },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CIRCULAR_DEPENDENCY');
      expect(result.error.message).toContain('Recursive module function dependency');
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
