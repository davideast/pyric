import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
});
