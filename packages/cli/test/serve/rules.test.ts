/** Rules wiring (plan step 1.5) — plain v2 passthrough, 2+modules resolution,
 *  parse/lint failure, file discovery semantics. */
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadProjectRules,
  prepareProjectRules,
  prepareRulesSource,
  prepareStorageRulesSource,
  rulesHashOf,
} from '../../src/serve/rules.js';

const PLAIN = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    match /pub/{id} { allow read: if true; }
  }
}`;

const MODULAR = `rules_version = '2+modules';
import { isAuthenticated } from 'auth';
service cloud.firestore {
  match /databases/{db}/documents {
    match /tasks/{id} { allow read: if isAuthenticated(); }
  }
}`;

const STORAGE_MODULAR = `rules_version = '2+modules';
import { sizeAtMost } from 'storage/uploads';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{fileName} { allow write: if sizeAtMost(1024); }
  }
}`;

describe('prepareRulesSource', () => {
  it('passes plain v2 through untouched', () => {
    expect(prepareRulesSource(PLAIN, 'x.rules')).toBe(PLAIN);
  });

  it('resolves 2+modules to plain v2 (the in-page evaluator contract)', () => {
    const out = prepareRulesSource(MODULAR, 'x.rules');
    expect(out).toContain("rules_version = '2'");
    expect(out).not.toContain('2+modules');
    expect(/^\s*import /m.test(out)).toBe(false);
    expect(out).toContain('isAuthenticated'); // inlined, not dropped
  });

  it('throws actionably on unresolvable imports and parse errors', () => {
    const badImport = MODULAR.replace("from 'auth'", "from 'does_not_exist'");
    expect(() => prepareRulesSource(badImport, 'bad.rules')).toThrow(/module resolution failed/);
    expect(() => prepareRulesSource('rules_version = ;;;', 'broken.rules')).toThrow(/failed to parse/);
  });
});

describe('a recursive wildcard with an always-true condition', () => {
  const wrap = (inner: string) => `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    ${inner}
  }
}`;

  it('serves the collection-group shape Firebase documents for a public collection group', () => {
    const source = wrap('match /{path=**}/items/{id} { allow read: if true; }');
    expect(prepareRulesSource(source, 'firestore.rules')).toBe(source);
  });

  it('refuses a final recursive wildcard at the root and names every document in the database', () => {
    expect(() => prepareRulesSource(wrap('match /{document=**} { allow read: if true; }'), 'firestore.rules'))
      .toThrow('match /{document=**} allows read on every document in the database with an always-true condition.');
  });
});

describe('a rules source past production\'s compile limits', () => {
  const overLetLimit = `rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {
    function g() {
${Array.from({ length: 12 }, (_, i) => `      let v${i} = ${i};`).join('\n')}
      return request.auth != null && v0 == 0;
    }
    match /pub/{id} { allow read: if g(); }
  }
}`;
  const deep = PLAIN.replace('if true', `if ${'('.repeat(300)}request.auth != null${')'.repeat(300)}`);

  it('fails to prepare with production\'s message and line', () => {
    expect(() => prepareProjectRules(overLetLimit, 'over.rules')).toThrow(
      'pyric sandbox: over.rules does not compile: Line 17: Maximum allowed variable count of 10 for a given function has been reached. Fix the rules before serving.',
    );
    expect(() => prepareProjectRules(deep, 'deep.rules')).toThrow(
      'pyric sandbox: deep.rules does not compile: Line 4: Expression is too complex to evaluate safely. Fix the rules before serving.',
    );
  });

  it('fails to prepare a ruleset with a second recursive wildcard in one declaration path', () => {
    const glob = 'Invalid glob match expression. Only one glob match is permitted in a match declaration path.';
    const inPath = PLAIN.replace('match /pub/{id}', 'match /{p=**}/items/{q=**}');
    expect(() => prepareProjectRules(inPath, 'glob.rules')).toThrow(
      `pyric sandbox: glob.rules does not compile: Line 4: ${glob} Fix the rules before serving.`,
    );
    const nested = PLAIN.replace('match /pub/{id} { allow read: if true; }',
      'match /{g=**}/groups/{gid} {\n      match /{rest=**} { allow read: if true; }\n    }');
    expect(() => prepareProjectRules(nested, 'nested.rules')).toThrow(
      `pyric sandbox: nested.rules does not compile: Line 5: ${glob} Fix the rules before serving.`,
    );
  });

  it('fails to prepare a Storage ruleset with production\'s message', () => {
    const storage = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /u/{f} { allow read: if ${'('.repeat(300)}request.auth != null${')'.repeat(300)}; }
  }
}`;
    expect(() => prepareStorageRulesSource(storage, 'storage.rules')).toThrow(
      'pyric sandbox: storage.rules does not compile: Line 4: Expression is too complex to evaluate safely. Fix the rules before serving.',
    );
  });
});

describe('prepareStorageRulesSource', () => {
  it('resolves Storage modules before parsing the sandbox ruleset', () => {
    const out = prepareStorageRulesSource(
      STORAGE_MODULAR,
      'storage.modules.rules',
    );
    expect(out).toContain("rules_version = '2';");
    expect(out).not.toContain('2+modules');
    expect(out).toContain('function sizeAtMost(maxBytes)');
  });

  it('reports a parse error that ends in a period without doubling it', () => {
    let message = '';
    try {
      prepareStorageRulesSource(
        "rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { allow read: if true;",
        'storage.rules',
      );
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain("expected '}' to close the match block opened at line 2. Fix the rules before serving.");
    expect(message).not.toContain('..');
  });
});

describe('loadProjectRules', () => {
  it('loads via the firebase.json path, hashes, records source path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-rules-'));
    writeFileSync(join(dir, 'custom.rules'), PLAIN);
    const loaded = await loadProjectRules(dir, { firestore: { rules: 'custom.rules' } });
    expect(loaded.rules).toBe(PLAIN);
    expect(loaded.rulesHash).toBe(rulesHashOf(PLAIN));
    expect(loaded.sourcePath).toContain('custom.rules');
  });

  it('defaults to ./firestore.rules when unconfigured; null when absent', async () => {
    const withFile = mkdtempSync(join(tmpdir(), 'pyric-serve-rules-'));
    writeFileSync(join(withFile, 'firestore.rules'), PLAIN);
    expect((await loadProjectRules(withFile, null)).rules).toBe(PLAIN);

    const empty = mkdtempSync(join(tmpdir(), 'pyric-serve-rules-'));
    const none = await loadProjectRules(empty, null);
    expect(none).toEqual({ rules: null, rulesHash: null, sourcePath: null, moduleFiles: [] });
  });

  it('throws when firebase.json names a missing file (explicit config = contract)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-rules-'));
    await expect(loadProjectRules(dir, { firestore: { rules: 'gone.rules' } })).rejects.toThrow(/does not exist/);
  });
});

describe('a rules source that fails to prepare', () => {
  const importing = (from: string) => `rules_version = '2+modules';
import { canRead } from '${from}';
service cloud.firestore {
  match /databases/{db}/documents {
    match /b/{id} { allow read: if canRead(); }
  }
}`;

  function failure(run: () => unknown): Error & { moduleFiles?: readonly string[] } {
    try {
      run();
    } catch (e) {
      return e as Error & { moduleFiles?: readonly string[] };
    }
    throw new Error('expected the rules to fail');
  }

  it('carries the missing module it looked for, as an absolute path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-rules-'));
    const main = join(dir, 'firestore.modules.rules');
    const error = failure(() => prepareProjectRules(importing('./b'), main));
    expect(error.message).toMatch(/module resolution failed/);
    expect(error.moduleFiles).toEqual([join(dir, 'b.rules')]);
  });

  it('carries the modules it imported when the resolved rules fail lint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-rules-'));
    const main = join(dir, 'firestore.modules.rules');
    writeFileSync(join(dir, 'b.rules'), `rules_version = '2+modules';
export function canRead() { return true; }`);
    const lintError = importing('./b').replace('if canRead()', "if canRead() && request.data.name == 'x'");
    const error = failure(() => prepareProjectRules(lintError, main));
    expect(error.message).toMatch(/rules error/);
    expect(error.moduleFiles).toEqual([join(dir, 'b.rules')]);
  });

  it('records a nested import in the directory of the module that imports it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-rules-'));
    mkdirSync(join(dir, 'games', 'pool'), { recursive: true });
    const main = join(dir, 'firestore.modules.rules');
    writeFileSync(join(dir, 'games', 'pool', 'pool.rules'), `rules_version = '2+modules';
import { helper } from './physics';
export function canRead() { return helper(); }`);
    const error = failure(() => prepareProjectRules(importing('./games/pool/pool'), main));
    expect(error.moduleFiles).toEqual([
      join(dir, 'games', 'pool', 'pool.rules'),
      join(dir, 'games', 'pool', 'physics.rules'),
    ]);
  });
});
