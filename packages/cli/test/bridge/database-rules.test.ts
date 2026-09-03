/**
 * `database_rules` end to end: lint, validate, and generate run in-process
 * through the composed MCP surface; simulate is forwarded to the sandbox
 * dispatcher and evaluates either the sandbox's loaded rules or a supplied
 * rules document.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeSandbox } from 'pyric/sandbox';
import { setData, setRules } from 'pyric/sandbox/database';
import { buildSandboxDispatcher } from '../../src/bridge/client/dispatch.js';
import { composeMcpTools, resolveToolCall, type McpTool } from '../../src/bridge/server/tool-surface.js';

const fixturesRoot = fileURLToPath(new URL('./fixtures-tmp-database-rules/', import.meta.url));

const OWNER_RULES = {
  rules: {
    notes: {
      $noteId: {
        '.read': 'auth !== null',
        '.write': "data.child('owner').val() === auth.uid",
      },
    },
  },
};

function databaseRules(): McpTool {
  return composeMcpTools().find((tool) => tool.name === 'database_rules')!;
}

async function call(args: Record<string, unknown>) {
  const resolution = resolveToolCall(databaseRules(), args);
  if (!resolution.ok) return resolution.result;
  return resolution.op.execute!(resolution.args);
}

describe('database_rules', () => {
  afterAll(() => {
    rmSync(fixturesRoot, { recursive: true, force: true });
  });

  it('forwards simulate and runs lint, validate, and generate in-process', () => {
    const tool = databaseRules();
    expect(tool.ops.map((op) => [op.op, op.transport])).toEqual([
      ['simulate', 'forwarded'],
      ['lint', 'in-process'],
      ['validate', 'in-process'],
      ['generate', 'in-process'],
    ]);
    expect(tool.ops.find((op) => op.op === 'simulate')!.execute).toBeUndefined();
    expect(tool.ops.find((op) => op.op === 'simulate')!.fields.map((field) => field.name)).toContain(
      'rules',
    );
  });

  it('lint and validate accept a rules document and report findings', async () => {
    const lint = await call({ op: 'lint', rules: OWNER_RULES });
    expect(lint).toMatchObject({ ok: true, data: { warnings: [] } });

    const validate = await call({ op: 'validate', rules: OWNER_RULES });
    expect(validate).toMatchObject({ ok: true, data: { errors: [] } });

    const broken = await call({ op: 'validate', rules: { rules: { notes: { '.write': 'auth.uid ==' } } } });
    expect(broken.ok).toBe(false);
    expect((broken.data as { errors: unknown[] }).errors.length).toBeGreaterThan(0);

    const rejected = await call({ op: 'lint', rules: OWNER_RULES, source: 'x' });
    expect(rejected.ok).toBe(false);
    expect(rejected.summary).toContain("'source' is not a field of op 'lint'");
  });

  it('generate compiles a constraints module from disk', async () => {
    mkdirSync(fixturesRoot, { recursive: true });
    const dir = mkdtempSync(join(fixturesRoot, 'generate-'));
    writeFileSync(
      join(dir, 'database.rules.ts'),
      [
        "import { allow, defineRtdbRules, deny } from 'pyric/rules';",
        'export const rules = defineRtdbRules({',
        "  paths: { '/': { read: allow(), write: deny() } },",
        '});',
      ].join('\n'),
    );
    const result = await call({ op: 'generate', configPath: 'database.rules.ts', cwd: dir });
    expect(result).toMatchObject({
      ok: true,
      data: { rulesJson: { rules: { '.read': true, '.write': false } } },
    });
  });

  it('simulate evaluates a supplied rules document in the sandbox, against sandbox data', async () => {
    const sandbox = initializeSandbox();
    const dispatch = buildSandboxDispatcher(sandbox);
    setData(sandbox, { '/notes/n1': { owner: 'alice', title: 'Draft' } });
    setRules(sandbox, { rules: { '.read': false, '.write': false } });

    const live = await dispatch('database_rules', 'simulate', {
      operation: 'write',
      path: '/notes/n1',
      auth: { uid: 'alice' },
      newData: { owner: 'alice', title: 'Edited' },
    });
    expect(live).toMatchObject({ ok: true, data: { decision: 'DENY' } });

    const supplied = await dispatch('database_rules', 'simulate', {
      operation: 'write',
      path: '/notes/n1',
      auth: { uid: 'alice' },
      newData: { owner: 'alice', title: 'Edited' },
      rules: OWNER_RULES,
    });
    expect(supplied).toMatchObject({ ok: true, data: { decision: 'ALLOW' } });

    const stranger = await dispatch('database_rules', 'simulate', {
      operation: 'write',
      path: '/notes/n1',
      auth: { uid: 'bob' },
      newData: { owner: 'bob' },
      rules: OWNER_RULES,
    });
    expect(stranger).toMatchObject({ ok: true, data: { decision: 'DENY' } });

    const invalid = await dispatch('database_rules', 'simulate', {
      operation: 'read',
      path: '/notes/n1',
      rules: { notes: {} },
    });
    expect(invalid).toMatchObject({ ok: false, data: { code: 'INVALID_RULES_JSON' } });
  });
});
