import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRtdbRulesTools } from '../../src/rtdb/rules-tools.js';

const fixturesRoot = fileURLToPath(new URL('./fixtures-tmp/', import.meta.url));
const ctx = { signal: new AbortController().signal };

function handler(name: string) {
  const tool = createRtdbRulesTools().find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`no handler ${name}`);
  return tool;
}

describe('createRtdbRulesTools', () => {
  let fixtureDir: string | undefined;

  afterAll(() => {
    rmSync(fixturesRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
    fixtureDir = undefined;
  });

  it('yields the lint, validate, and generate handlers', () => {
    expect(createRtdbRulesTools().map((tool) => tool.name)).toEqual([
      'rtdb_lint_rules',
      'rtdb_validate_rules',
      'rtdb_generate_rules',
    ]);
  });

  it('lint and validate report a clean ruleset', async () => {
    const rules = { rules: { notes: { $id: { '.read': 'auth !== null', '.write': 'auth !== null' } } } };
    const lint = await handler('rtdb_lint_rules').execute({ rules }, ctx);
    expect(lint).toMatchObject({ ok: true, summary: 'Lint clean', data: { warnings: [] } });
    const validate = await handler('rtdb_validate_rules').execute({ rules }, ctx);
    expect(validate).toMatchObject({ ok: true, summary: 'Validation clean', data: { errors: [] } });
  });

  it('lint reports a warning keyed by path and rule and stays ok', async () => {
    const rules = { rules: { notes: { '.read': 'auth != null' } } };
    const result = await handler('rtdb_lint_rules').execute({ rules }, ctx);
    expect(result).toMatchObject({
      ok: true,
      summary: 'Lint found 1 warning',
      data: { warnings: [{ path: '/notes', rule: '.read', code: 'LOOSE_INEQUALITY' }] },
    });
  });

  it('validate reports an expression error keyed by path and rule', async () => {
    const rules = { rules: { notes: { '.read': 'auth.uid ==' } } };
    const result = await handler('rtdb_validate_rules').execute({ rules }, ctx);
    expect(result.ok).toBe(false);
    const { errors } = result.data as { errors: { path: string; rule: string }[] };
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatchObject({ path: '/notes', rule: '.read' });
  });

  it('lint and validate reject a document without a rules key', async () => {
    for (const name of ['rtdb_lint_rules', 'rtdb_validate_rules']) {
      const result = await handler(name).execute({ rules: { notes: {} } }, ctx);
      expect(result.ok).toBe(false);
      expect(result.data).toEqual({ code: 'INVALID_RULES_JSON' });
    }
  });

  it('generate compiles a constraints module into database.rules.json data', async () => {
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

    const result = await handler('rtdb_generate_rules').execute(
      { configPath: 'database.rules.ts', cwd: fixtureDir },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      rulesJson: { rules: { '.read': true, '.write': false } },
    });
  });

  it('generate reports a missing constraints module without throwing', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    fixtureDir = mkdtempSync(join(fixturesRoot, 'missing-'));

    const result = await handler('rtdb_generate_rules').execute(
      { configPath: 'missing.ts', cwd: fixtureDir },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('failed to load RTDB constraints module');
  });
});
