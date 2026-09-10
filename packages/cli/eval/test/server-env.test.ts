/**
 * The eval never mounts a `production` method, which `CONTRACT.md` states and
 * this file enforces.
 *
 * The harness inherits the environment of whoever started it, so a maintainer
 * who has `PYRIC_ALLOW_PRODUCTION` set for their own session would otherwise
 * hand it to every agent process, and from there to the MCP server the agent's
 * CLI spawns. Withholding it is not the absence of a setting, it is a deletion,
 * and the deletion is tested here rather than assumed.
 */
import 'fake-indexeddb/auto';
import { describe, expect, test } from 'bun:test';
import { initializeSandbox } from 'pyric/sandbox';

import { createSurfaceContext, renderSurface } from '../../src/bridge/surface/index.js';
import { allowProductionFrom } from '../../src/bridge/surface/method-effects.js';
import { buildInvocation as buildClaude } from '../providers/claude.js';
import { buildInvocation as buildCodex } from '../providers/codex.js';
import { buildInvocation as buildAntigravity } from '../providers/antigravity.js';
import { buildInvocation as buildFake } from '../providers/fake.js';
import { runEnv, spawnEnv, WITHHELD_ENV_KEYS } from '../providers/server-env.js';
import type { BuildInvocation, EvalRow, EvalRun, EvalTask } from '../types.js';

const TASK: EvalTask = {
  id: 'read-a-post',
  prompt: 'Read the post at posts/p1 and tell me its title.',
  seed: {},
  acceptedFirstOperations: ['get_firestore_document'],
  assert: () => true,
  tags: ['firestore', 'read'],
};

const ROW: EvalRow = {
  id: 'claude-sonnet-mcp-only',
  cli: 'claude',
  model: 'claude-sonnet-4-5',
  condition: 'mcp-only',
  seeds: [7],
};

const RUN: EvalRun = {
  runId: 'run-1',
  row: ROW,
  variant: 'verb-prefixed',
  task: TASK,
  seed: 7,
  dir: '/runs/run-1/row/verb-prefixed/read-a-post/7',
  workspaceDir: '/runs/run-1/row/verb-prefixed/read-a-post/7/workspace',
  stateDir: '/state/run-1/row/verb-prefixed/read-a-post/7',
  eventsPath: '/state/run-1/row/verb-prefixed/read-a-post/7/events.ndjson',
  serverCommand: ['node', '/repo/packages/cli/dist/cli/index.js', 'mcp', '--in-process'],
  repoRoot: '/repo',
};

const PROVIDERS: ReadonlyArray<[string, BuildInvocation]> = [
  ['claude', buildClaude],
  ['codex', buildCodex],
  ['antigravity', buildAntigravity],
  ['fake', buildFake],
];

describe('the eval withholds production access', () => {
  test('names the production flag among the variables it withholds', () => {
    expect(WITHHELD_ENV_KEYS).toContain('PYRIC_ALLOW_PRODUCTION');
  });

  test('deletes a withheld variable the parent process carries', () => {
    const parent = { PATH: '/usr/bin', PYRIC_ALLOW_PRODUCTION: '1' };
    const merged = spawnEnv(parent, { PYRIC_EVAL_RUN_ID: 'run-1' });
    expect(merged.PATH).toBe('/usr/bin');
    expect(merged.PYRIC_EVAL_RUN_ID).toBe('run-1');
    expect('PYRIC_ALLOW_PRODUCTION' in merged).toBe(false);
  });

  test('deletes a withheld variable an invocation carries', () => {
    const merged = spawnEnv({}, { PYRIC_ALLOW_PRODUCTION: 'true' });
    expect('PYRIC_ALLOW_PRODUCTION' in merged).toBe(false);
  });

  test('refuses the hosted rules test on a server started the way a run starts one', async () => {
    // The parent has the variable set, which is the case the withholding
    // exists for, and the spawned environment is what the server would read.
    const spawned = spawnEnv({ PYRIC_ALLOW_PRODUCTION: '1' }, runEnv(RUN));
    const allowProduction = allowProductionFrom(false, spawned);
    expect(allowProduction).toBe(false);

    const tool = renderSurface('sdk-service', { allowProduction }).tools.find(
      (candidate) => candidate.name === 'assurance',
    );
    if (tool === undefined) throw new Error('the sdk-service surface renders no assurance tool');
    const refused = await tool.execute(
      {
        method: 'testRulesHosted',
        args: {
          service: 'firestore',
          rules: "rules_version = '2';",
          cases: [{ description: 'one', expectation: 'ALLOW', method: 'get', path: 'orders/o1' }],
          confirm: true,
        },
      },
      createSurfaceContext(initializeSandbox(), process.cwd()),
    );
    expect(refused.ok).toBe(false);
    expect(refused.summary).toContain('--allow-production');
  });

  for (const [name, build] of PROVIDERS) {
    test(`${name} passes neither the production flag nor the variable`, () => {
      const invocation = build(RUN);
      const written = Object.values({
        ...invocation.files,
        ...invocation.workspaceFiles,
      }).join('\n');
      const spelled = [
        invocation.command.join(' '),
        JSON.stringify(invocation.env),
        written,
      ].join('\n');
      expect(spelled).not.toContain('--allow-production');
      expect(spelled).not.toContain('PYRIC_ALLOW_PRODUCTION');
    });
  }
});
