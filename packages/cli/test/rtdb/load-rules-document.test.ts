import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serverTimestamp } from 'pyric/rules';
import { loadRtdbRulesDocument } from '../../src/rtdb/load-rules-document.js';

const fixturesRoot = fileURLToPath(new URL('./fixtures-load-doc-tmp/', import.meta.url));

describe('loadRtdbRulesDocument', () => {
  let fixtureDir: string | undefined;

  afterAll(() => {
    rmSync(fixturesRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  test('falls back to default export when named rules export is a non-document helper (TXT-4a)', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(fixturesRoot, 'fallback-'));
    writeFileSync(
      join(fixtureDir, 'database.rules.ts'),
      [
        "import { allow, defineRtdbRules, deny } from 'pyric/rules';",
        'export const rules = { helper: true };',
        'export default defineRtdbRules({',
        "  paths: { '/': { read: allow(), write: deny() } },",
        '});',
      ].join('\n'),
    );

    const loaded = await loadRtdbRulesDocument('database.rules.ts', { cwd: fixtureDir });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.document.toJSON()).toEqual({
      rules: { '.read': true, '.write': false },
    });
  });

  test('rejects unrelated objects with a .toJSON() method such as Date and falls back to default (TXT-4b)', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(fixturesRoot, 'tojson-'));
    writeFileSync(
      join(fixtureDir, 'date-only.rules.ts'),
      'export const rules = new Date(0);\n',
    );
    const rejected = await loadRtdbRulesDocument('date-only.rules.ts', { cwd: fixtureDir });
    expect(rejected.ok).toBe(false);

    writeFileSync(
      join(fixtureDir, 'date-with-default.rules.ts'),
      [
        "import { allow, defineRtdbRules } from 'pyric/rules';",
        'export const rules = new Date(0);',
        'export default defineRtdbRules({',
        "  paths: { '/items': { read: allow() } },",
        '});',
      ].join('\n'),
    );
    const fallback = await loadRtdbRulesDocument('date-with-default.rules.ts', { cwd: fixtureDir });
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect(fallback.document.toJSON()).toEqual({
      rules: { items: { '.read': true } },
    });
  });

  test('reloads modified rules module across edits in the same process for named and default exports and sibling imports (TXT-4c)', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(fixturesRoot, 'reload-'));

    // 1. Named `rules` export modified in place
    const namedFile = join(fixtureDir, 'named.rules.ts');
    writeFileSync(
      namedFile,
      [
        "import { allow, defineRtdbRules, deny } from 'pyric/rules';",
        'export const rules = defineRtdbRules({',
        "  paths: { '/named': { read: allow(), write: deny() } },",
        '});',
      ].join('\n'),
    );
    const namedFirst = await loadRtdbRulesDocument('named.rules.ts', { cwd: fixtureDir });
    expect(namedFirst.ok).toBe(true);
    if (!namedFirst.ok) return;
    expect(namedFirst.document.toJSON()).toEqual({
      rules: { named: { '.read': true, '.write': false } },
    });

    writeFileSync(
      namedFile,
      [
        "import { allow, defineRtdbRules, deny } from 'pyric/rules';",
        'export const rules = defineRtdbRules({',
        "  paths: { '/named': { read: deny(), write: allow() } },",
        '});',
      ].join('\n'),
    );
    const namedSecond = await loadRtdbRulesDocument('named.rules.ts', { cwd: fixtureDir });
    expect(namedSecond.ok).toBe(true);
    if (!namedSecond.ok) return;
    expect(namedSecond.document.toJSON()).toEqual({
      rules: { named: { '.read': false, '.write': true } },
    });

    // 2. Default export modified in place
    const defaultFile = join(fixtureDir, 'default.rules.ts');
    writeFileSync(
      defaultFile,
      [
        "import { allow, defineRtdbRules, deny } from 'pyric/rules';",
        'export default defineRtdbRules({',
        "  paths: { '/def': { read: allow(), write: deny() } },",
        '});',
      ].join('\n'),
    );
    const defaultFirst = await loadRtdbRulesDocument('default.rules.ts', { cwd: fixtureDir });
    expect(defaultFirst.ok).toBe(true);
    if (!defaultFirst.ok) return;
    expect(defaultFirst.document.toJSON()).toEqual({
      rules: { def: { '.read': true, '.write': false } },
    });

    writeFileSync(
      defaultFile,
      [
        "import { allow, defineRtdbRules } from 'pyric/rules';",
        'export default defineRtdbRules({',
        "  paths: { '/def': { read: allow(), write: allow() } },",
        '});',
      ].join('\n'),
    );
    const defaultSecond = await loadRtdbRulesDocument('default.rules.ts', { cwd: fixtureDir });
    expect(defaultSecond.ok).toBe(true);
    if (!defaultSecond.ok) return;
    expect(defaultSecond.document.toJSON()).toEqual({
      rules: { def: { '.read': true, '.write': true } },
    });

    // 3. Unchanged entry module that imports a sibling file which changes on disk
    const siblingFile = join(fixtureDir, 'shared-rules.ts');
    const entryWithSibling = join(fixtureDir, 'with-sibling.rules.ts');
    writeFileSync(
      siblingFile,
      [
        "import { allow, deny } from 'pyric/rules';",
        'export const sharedRead = allow();',
        'export const sharedWrite = deny();',
      ].join('\n'),
    );
    writeFileSync(
      entryWithSibling,
      [
        "import { defineRtdbRules } from 'pyric/rules';",
        "import { sharedRead, sharedWrite } from './shared-rules.ts';",
        'export const rules = defineRtdbRules({',
        "  paths: { '/posts': { read: sharedRead, write: sharedWrite } },",
        '});',
      ].join('\n'),
    );

    const siblingFirst = await loadRtdbRulesDocument('with-sibling.rules.ts', { cwd: fixtureDir });
    expect(siblingFirst.ok).toBe(true);
    if (!siblingFirst.ok) return;
    expect(siblingFirst.document.toJSON()).toEqual({
      rules: { posts: { '.read': true, '.write': false } },
    });

    writeFileSync(
      siblingFile,
      [
        "import { allow, authenticated } from 'pyric/rules';",
        'export const sharedRead = authenticated();',
        'export const sharedWrite = allow();',
      ].join('\n'),
    );

    const siblingSecond = await loadRtdbRulesDocument('with-sibling.rules.ts', { cwd: fixtureDir });
    expect(siblingSecond.ok).toBe(true);
    if (!siblingSecond.ok) return;
    expect(siblingSecond.document.toJSON()).toEqual({
      rules: { posts: { '.read': 'auth != null', '.write': true } },
    });
  });

  test('preserves normalizeSimulationInput semantics including serverTimestamp() on loaded document.simulate()', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(fixturesRoot, 'sim-'));
    writeFileSync(
      join(fixtureDir, 'stamp.rules.ts'),
      [
        "import { defineRtdbRules, expr } from 'pyric/rules';",
        'export const rules = defineRtdbRules({',
        "  paths: { '/stamped': { write: expr('newData.val() === now') } },",
        '});',
      ].join('\n'),
    );

    const loaded = await loadRtdbRulesDocument('stamp.rules.ts', { cwd: fixtureDir });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const sim = loaded.document.simulate({
      operation: 'write',
      path: '/stamped',
      newData: serverTimestamp(),
    });
    expect(sim).toMatchObject({ success: true, data: { allowed: true } });
  });

  test('reports errors thrown during module evaluation and times out never-settling modules', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(fixturesRoot, 'errors-'));
    writeFileSync(
      join(fixtureDir, 'throws.rules.ts'),
      "throw new Error('custom evaluation failure');\n",
    );

    const thrown = await loadRtdbRulesDocument('throws.rules.ts', { cwd: fixtureDir });
    expect(thrown.ok).toBe(false);
    if (thrown.ok) return;
    expect(thrown.message).toContain('failed to load RTDB constraints module');
    expect(thrown.message).toContain('custom evaluation failure');

    writeFileSync(
      join(fixtureDir, 'hangs.rules.ts'),
      'await new Promise((resolve) => setTimeout(resolve, 60_000));\nexport const rules = {};\n',
    );

    const hung = await loadRtdbRulesDocument('hangs.rules.ts', {
      cwd: fixtureDir,
      timeoutMs: 100,
    });
    expect(hung.ok).toBe(false);
    if (hung.ok) return;
    expect(hung.message).toContain('timed out after 100ms');
  });
});
