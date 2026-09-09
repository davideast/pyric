/**
 * Provider invocations are snapshot tested. A CLI flag or a config key that
 * changes silently would change what the eval measures without changing any
 * number in the report, so the exact command array and the exact files each
 * provider writes are pinned here for one row.
 */
import { describe, expect, test } from 'bun:test';
import { buildInvocation as buildClaude, MCP_CONFIG_KEYS } from '../providers/claude.js';
import { buildInvocation as buildCodex, CODEX_PROFILE } from '../providers/codex.js';
import { buildInvocation as buildAntigravity } from '../providers/antigravity.js';
import { buildInvocation as buildFake } from '../providers/fake.js';
import { defaultServerCommand } from '../providers/server-env.js';
import type { EvalRow, EvalRun, EvalTask } from '../types.js';

const TASK: EvalTask = {
  id: 'read-a-post',
  prompt: 'Read the post at posts/p1 and tell me its title.',
  seed: {},
  acceptedFirstOperations: ['get_firestore_document'],
  assert: () => true,
  tags: ['firestore', 'read'],
};

function runFor(row: EvalRow, variant = 'verb-prefixed'): EvalRun {
  return {
    runId: 'run-1',
    row,
    variant,
    task: TASK,
    seed: 7,
    dir: '/runs/run-1/row/verb-prefixed/read-a-post/7',
    eventsPath: '/runs/run-1/row/verb-prefixed/read-a-post/7/events.ndjson',
    serverCommand: ['node', '/repo/packages/cli/dist/cli/index.js', 'mcp', '--headless', '--surface', variant],
    repoRoot: '/repo',
  };
}

const CLAUDE_ROW: EvalRow = {
  id: 'claude-default',
  cli: 'claude',
  model: 'claude-opus-4',
  effort: 'high',
  condition: 'agent-default',
  seeds: [7],
};

describe('provider invocations', () => {
  test('the default server command is the local build of the CLI entry', () => {
    expect(defaultServerCommand('/repo', 'noun-prefixed')).toEqual([
      'node',
      '/repo/packages/cli/dist/cli/index.js',
      'mcp',
      '--headless',
      '--surface',
      'noun-prefixed',
    ]);
  });

  test('claude', () => {
    const invocation = buildClaude(runFor(CLAUDE_ROW));
    expect(invocation.command).toEqual([
      'claude',
      '-p',
      TASK.prompt,
      '--output-format',
      'stream-json',
      '--model',
      'claude-opus-4',
      '--effort',
      'high',
      '--max-turns',
      '25',
      '--permission-mode',
      'dontAsk',
      '--mcp-config',
      '/runs/run-1/row/verb-prefixed/read-a-post/7/mcp-config.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__pyric__*',
    ]);

    const config = JSON.parse(invocation.files['mcp-config.json'] as string) as Record<
      string,
      { pyric: { type: string; command: string; args: string[]; env: Record<string, string> } }
    >;
    for (const key of MCP_CONFIG_KEYS) {
      expect(config[key]?.pyric.type).toBe('stdio');
      expect(config[key]?.pyric.command).toBe('node');
      expect(config[key]?.pyric.args).toEqual([
        '/repo/packages/cli/dist/cli/index.js',
        'mcp',
        '--headless',
        '--surface',
        'verb-prefixed',
      ]);
    }
    expect(config.mcpServers?.pyric.env).toEqual({
      PYRIC_EVAL_LOG: '/runs/run-1/row/verb-prefixed/read-a-post/7/events.ndjson',
      PYRIC_EVAL_RUN_ID: 'run-1',
      PYRIC_EVAL_TASK_ID: 'read-a-post',
      PYRIC_EVAL_VARIANT: 'verb-prefixed',
      PYRIC_EVAL_CLI: 'claude',
      PYRIC_EVAL_MODEL: 'claude-opus-4',
      PYRIC_EVAL_EFFORT: 'high',
      PYRIC_EVAL_CONDITION: 'agent-default',
      PYRIC_EVAL_SEED: '7',
      PYRIC_TOOL_SURFACE: 'verb-prefixed',
    });
  });

  test('claude in the mcp-only condition withdraws the built-in tools', () => {
    const row: EvalRow = { ...CLAUDE_ROW, id: 'claude-mcp-only', condition: 'mcp-only' };
    const invocation = buildClaude(runFor(row));
    expect(invocation.command.slice(-2)).toEqual(['--tools', '']);
  });

  test('codex', () => {
    const row: EvalRow = {
      id: 'codex-default',
      cli: 'codex',
      model: 'gpt-5-codex',
      effort: 'medium',
      condition: 'agent-default',
      seeds: [7],
    };
    const invocation = buildCodex(runFor(row));
    expect(invocation.command).toEqual([
      'codex',
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '-m',
      'gpt-5-codex',
      '-c',
      `model_reasoning_effort='"medium"'`,
      '-c',
      `approval_policy='"never"'`,
      '-s',
      'workspace-write',
      '--profile',
      CODEX_PROFILE,
      TASK.prompt,
    ]);
    expect(invocation.env).toEqual({
      CODEX_HOME: '/runs/run-1/row/verb-prefixed/read-a-post/7/codex-home',
    });

    const config = invocation.files['codex-home/config.toml'] as string;
    expect(config).toContain(`[profiles.${CODEX_PROFILE}]`);
    expect(config).toContain('model = "gpt-5-codex"');
    expect(config).toContain('model_reasoning_effort = "medium"');
    expect(config).toContain('[mcp_servers.pyric]');
    expect(config).toContain('command = "node"');
    expect(config).toContain('PYRIC_TOOL_SURFACE = "verb-prefixed"');
  });

  test('antigravity', () => {
    const row: EvalRow = {
      id: 'antigravity-default',
      cli: 'antigravity',
      model: 'gemini-3-pro-high',
      condition: 'agent-default',
      seeds: [7],
    };
    const invocation = buildAntigravity(runFor(row));
    expect(invocation.command).toEqual([
      'agy',
      '-p',
      TASK.prompt,
      '--output-format',
      'stream-json',
      '--model',
      'gemini-3-pro-high',
      '--dangerously-skip-permissions',
      '--print-timeout',
      '10m',
      '--add-dir',
      '/runs/run-1/row/verb-prefixed/read-a-post/7',
    ]);

    const config = JSON.parse(invocation.files['.agents/mcp_config.json'] as string) as {
      mcpServers: { pyric: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(config.mcpServers.pyric.command).toBe('node');
    expect(config.mcpServers.pyric.env.PYRIC_EVAL_EFFORT).toBe('');
    expect(config.mcpServers.pyric.env.PYRIC_TOOL_SURFACE).toBe('verb-prefixed');
  });

  test('fake', () => {
    const row: EvalRow = {
      id: 'fake-row',
      cli: 'claude',
      model: 'fake',
      condition: 'agent-default',
      seeds: [7],
    };
    const run = runFor(row);
    run.fakeTranscript = [{ tool: 'get_firestore_document', args: { path: 'posts/p1' } }];
    const invocation = buildFake(run);
    expect(invocation.command[0]).toBe('bun');
    expect(invocation.command[2]).toBe(
      '/runs/run-1/row/verb-prefixed/read-a-post/7/fake-plan.json',
    );

    const plan = JSON.parse(invocation.files['fake-plan.json'] as string) as {
      server: { command: string; args: string[] };
      transcript: Array<{ tool: string; args: Record<string, unknown> }>;
    };
    expect(plan.server.command).toBe('node');
    expect(plan.transcript).toEqual([
      { tool: 'get_firestore_document', args: { path: 'posts/p1' } },
    ]);
  });
});
