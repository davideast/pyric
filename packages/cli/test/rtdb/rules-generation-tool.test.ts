import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRtdbRulesGenerationTools } from '../../src/rtdb/rules-generation-tool.js';

const fixturesRoot = fileURLToPath(new URL('./fixtures-tmp/', import.meta.url));

describe('createRtdbRulesGenerationTools', () => {
  let fixtureDir: string | undefined;

  afterAll(() => {
    rmSync(fixturesRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it('compiles a constraints module into database.rules.json data', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(fixturesRoot, 'generate-'));
    writeFileSync(
      join(fixtureDir, 'database.rules.ts'),
      [
        "import { allow, defineRtdbRules, deny } from 'pyric/rules';",
        'export const rules = defineRtdbRules({',
        "  paths: { '/': { read: allow(), write: deny() } },",
        '});',
      ].join('\n'),
    );

    const [tool] = createRtdbRulesGenerationTools();
    const result = await tool.execute(
      { configPath: 'database.rules.ts', cwd: fixtureDir },
      { signal: new AbortController().signal },
    );

    expect(tool.name).toBe('rtdb_generate_rules');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      rulesJson: { rules: { '.read': true, '.write': false } },
    });
  });

  it('reports a missing constraints module without throwing', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(fixturesRoot, 'missing-'));
    const [tool] = createRtdbRulesGenerationTools();

    const result = await tool.execute(
      { configPath: 'missing.ts', cwd: fixtureDir },
      { signal: new AbortController().signal },
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('failed to load RTDB constraints module');
  });
});
