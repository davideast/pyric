/** Rules wiring (plan step 1.5) — plain v2 passthrough, 2+modules resolution,
 *  parse/lint failure, file discovery semantics. */
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadProjectRules,
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
    expect(none).toEqual({ rules: null, rulesHash: null, sourcePath: null });
  });

  it('throws when firebase.json names a missing file (explicit config = contract)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyric-serve-rules-'));
    await expect(loadProjectRules(dir, { firestore: { rules: 'gone.rules' } })).rejects.toThrow(/does not exist/);
  });
});
