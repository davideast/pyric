/**
 * The MCP server block every provider embeds in its own config format, and the
 * environment the server is started with. Kept in one place so the three real
 * CLIs and the fake provider configure the same server the same way.
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
    join(repoRoot, 'packages', 'cli', 'dist', 'bin', 'pyric.js'),
    'mcp',
    '--headless',
    '--surface',
    variant,
  ];
}

/**
 * The `PYRIC_EVAL_*` block section 3 reads at server start, plus the surface
 * selection and the events log target. Every provider puts this in the server's
 * env, never in the CLI's own env, so the values ride with the process that
 * writes the log.
 */
export function serverEnv(run: EvalRun): Record<string, string> {
  const effort = run.row.effort ?? '';
  return {
    PYRIC_EVAL_LOG: run.eventsPath,
    PYRIC_EVAL_RUN_ID: run.runId,
    PYRIC_EVAL_TASK_ID: run.task.id,
    PYRIC_EVAL_VARIANT: run.variant,
    PYRIC_EVAL_CLI: run.row.cli,
    PYRIC_EVAL_MODEL: run.row.model,
    PYRIC_EVAL_EFFORT: effort,
    PYRIC_EVAL_CONDITION: run.row.condition,
    PYRIC_EVAL_SEED: String(run.seed),
    PYRIC_TOOL_SURFACE: run.variant,
  };
}

/** The `{ command, args, env }` server entry the three config formats all embed. */
export function serverEntry(run: EvalRun): {
  command: string;
  args: string[];
  env: Record<string, string>;
} {
  const [command, ...args] = run.serverCommand;
  if (command === undefined) throw new Error(`run ${run.runId} has an empty server command`);
  return { command, args, env: serverEnv(run) };
}
