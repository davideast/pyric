/**
 * The MCP server block every provider embeds in its own config format, and the
 * environment the server is started with. Kept in one place so the three real
 * CLIs and the fake provider configure the same server the same way.
 *
 * The split here is the point: `runEnv` holds everything that names this run and
 * travels in the CLI process environment, `configEnv` holds the one variable a
 * config file may carry.
 */
import { join } from 'node:path';
import type { EvalRun } from '../types.js';

/**
 * The local build the eval always drives. Injectable through `EvalRun.serverCommand`
 * so tests can substitute a stand-in stdio server that speaks the same contract.
 */
export function defaultServerCommand(repoRoot: string, variant: string): string[] {
  return [
    'node',
    join(repoRoot, 'packages', 'cli', 'dist', 'cli', 'index.js'),
    'mcp',
    '--headless',
    '--surface',
    variant,
  ];
}

/**
 * Everything about this particular run: the state directory, the events log
 * target and the `PYRIC_EVAL_*` block section 3 reads at server start.
 *
 * None of it goes into an MCP config. An agent with file tools can read the
 * config the CLI hands it, and a config that names the state directory hands the
 * agent a path to the answers, so the run measures file reading instead of the
 * tool surface. These values travel in the CLI process environment instead, and
 * the MCP server the CLI spawns inherits them.
 */
export function runEnv(run: EvalRun): Record<string, string> {
  const effort = run.row.effort ?? '';
  return {
    PYRIC_PROJECT_DIR: run.stateDir,
    PYRIC_EVAL_LOG: run.eventsPath,
    PYRIC_EVAL_RUN_ID: run.runId,
    PYRIC_EVAL_TASK_ID: run.task.id,
    PYRIC_EVAL_VARIANT: run.variant,
    PYRIC_EVAL_CLI: run.row.cli,
    PYRIC_EVAL_MODEL: run.row.model,
    PYRIC_EVAL_EFFORT: effort,
    PYRIC_EVAL_CONDITION: run.row.condition,
    PYRIC_EVAL_SEED: String(run.seed),
  };
}

/**
 * The only environment an MCP config carries. The surface id is already visible
 * in the argument list, so writing it here leaks nothing and keeps every
 * provider's config the same shape.
 */
export function configEnv(run: EvalRun): Record<string, string> {
  return { PYRIC_TOOL_SURFACE: run.variant };
}

/** The full server environment, for a provider that spawns the server itself. */
export function serverEnv(run: EvalRun): Record<string, string> {
  return { ...runEnv(run), ...configEnv(run) };
}

/** The `{ command, args, env }` server entry the three config formats all embed. */
export function serverEntry(run: EvalRun): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const [command, ...args] = run.serverCommand;
  if (command === undefined) throw new Error(`run ${run.runId} has an empty server command`);
  return { command, args, env: configEnv(run) };
}
