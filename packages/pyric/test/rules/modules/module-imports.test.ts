import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveModules } from '../../../src/rules/modules/resolver.js';
import { resolveModulesBrowser } from '../../../src/rules/modules/resolver-browser.js';

const source = (imports: string, rules: string) => `rules_version = '2+modules';
${imports}
service cloud.firestore {
  match /databases/{database}/documents {
    match /games/{id} {
      ${rules}
    }
  }
}`;

const gameModule = `rules_version = '2+modules';
import { validCreate } from 'lobby';
import { isMyTurn, turnFlipped } from 'turns';

// Game rules for one collection.
export function gameCreate() { return validCreate(); }
export function gameMove() { return isMyTurn() && turnFlipped(); }
`;

const gameSource = source(
  "import { gameCreate, gameMove } from './game';",
  'allow create: if gameCreate();\n      allow update: if gameMove();',
);

describe('imports inside a module', () => {
  test('a module with a 2+modules header imports the stdlib functions it calls', () => {
    const result = resolveModules(gameSource, { modules: { './game': gameModule } });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.resolved).toContain('function validCreate()');
    expect(result.data.resolved).toContain('function isMyTurn()');
    expect(result.data.resolved).toContain('function gameCreate()');
    expect(result.data.resolved).not.toMatch(/^\s*import /m);
    expect(result.data.modules).toEqual(['./game', 'lobby', 'turns']);
    expect(result.data.bundledModules).toEqual(['lobby', 'turns']);
  });

  test('a module without a version line may import', () => {
    const result = resolveModules(gameSource, {
      modules: { './game': gameModule.replace("rules_version = '2+modules';\n", '') },
    });
    expect(result.success).toBe(true);
  });

  test('the dev server path resolves stdlib imports inside a supplied module', () => {
    const result = resolveModulesBrowser(gameSource, { modules: { './game': gameModule } });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.resolved).toContain('function validCreate()');
  });

  test('a module that declares another rules version is rejected by name', () => {
    const result = resolveModules(gameSource, {
      modules: { './game': gameModule.replace("'2+modules'", "'2'") },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('NOT_MODULE_SOURCE');
    expect(result.error.message).toContain("'./game'");
  });

  test('an import after a function says imports come first', () => {
    const result = resolveModules(gameSource, {
      modules: {
        './game': "export function gameCreate() { return validCreate(); }\nexport function gameMove() { return true; }\nimport { validCreate } from 'lobby';\n",
      },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('PARSE_FAILED');
    expect(result.error.message).toContain('before its first function');
  });

  test("a nested relative import resolves from the importing module's directory", () => {
    const result = resolveModules(
      source("import { gameCreate } from './games/tictactoe';", 'allow create: if gameCreate();'),
      {
        modules: {
          './games/tictactoe': "import { seated } from './shared';\nexport function gameCreate() { return seated(); }\n",
          './games/shared': 'export function seated() { return request.auth != null; }\n',
        },
      },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.resolved).toContain('function seated()');
    expect(result.data.modules).toEqual(['./games/tictactoe', './games/shared']);
  });

  test("a module that calls another module's export needs its own import", () => {
    const modules = {
      './a': 'export function first() { return true; }\nexport function other() { return false; }\n',
      './b': 'export function second() { return first(); }\n',
    };
    const withoutImport = resolveModules(
      source("import { other } from './a';\nimport { second } from './b';", 'allow create: if other() || second();'),
      { modules },
    );
    expect(withoutImport.success).toBe(false);
    if (!withoutImport.success) expect(withoutImport.error.code).toBe('UNKNOWN_FUNCTION');

    const withImport = resolveModules(
      source("import { other } from './a';\nimport { second } from './b';", 'allow create: if other() || second();'),
      { modules: { ...modules, './b': "import { first } from './a';\n" + modules['./b'] } },
    );
    expect(withImport.success).toBe(true);
    if (withImport.success) expect(withImport.data.resolved).toContain('function first()');
  });

  test('a module cannot import a function its source module does not export', () => {
    const result = resolveModules(
      source("import { gameCreate } from './game';", 'allow create: if gameCreate();'),
      { modules: { './game': "import { isWaiting } from 'lobby';\nexport function gameCreate() { return isWaiting(); }\n" } },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('UNKNOWN_FUNCTION');
    expect(result.error.message).toContain('not exported');
  });

  test('modules that import each other are loaded once', () => {
    const result = resolveModules(
      source("import { first } from './a';", 'allow create: if first();'),
      {
        modules: {
          './a': "import { second } from './b';\nexport function first() { return second(); }\nexport function leaf() { return true; }\n",
          './b': "import { leaf } from './a';\nexport function second() { return leaf(); }\n",
        },
      },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.resolved.match(/function leaf\(/g)).toHaveLength(1);
    expect(result.data.modules).toEqual(['./a', './b']);
  });

  test('a stdlib function imported by the source and by a module appears once', () => {
    const result = resolveModules(
      source("import { validCreate } from 'lobby';\nimport { gameCreate } from './game';", 'allow create: if validCreate() && gameCreate();'),
      { modules: { './game': gameModule } },
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.resolved.match(/function validCreate\(/g)).toHaveLength(1);
  });

  test('a module on disk imports a sibling file and the stdlib', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-module-imports-'));
    mkdirSync(join(dir, 'games'));
    writeFileSync(
      join(dir, 'games', 'tictactoe.rules'),
      "rules_version = '2+modules';\nimport { validCreate } from 'lobby';\nimport { seated } from './shared';\nexport function gameCreate() { return validCreate() && seated(); }\n",
    );
    writeFileSync(join(dir, 'games', 'shared.rules'), 'export function seated() { return request.auth != null; }\n');
    const result = resolveModules(
      source("import { gameCreate } from './games/tictactoe';", 'allow create: if gameCreate();'),
      { basePath: dir },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.resolved).toContain('function seated()');
    expect(result.data.resolved).toContain('function validCreate()');
  });
});
