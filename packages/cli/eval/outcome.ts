/**
 * Classifies a finished run beyond its raw spawn outcome, using the signals
 * each provider owns under `providers/<cli>-signals.ts`. These three refined
 * outcomes exist because a CLI's infrastructure failures read like a task
 * failure unless the raw stdout and stderr are checked: a quota refusal
 * (`throttled`), a stream cut off mid-run (`interrupted`), and a run that
 * touched the sandbox through the agent's own file tools instead of the MCP
 * surface under test (`bypassed`).
 *
 * This never touches the scorer's own evidence. `score.ts` still reads only
 * the event log and the sandbox snapshot to decide pass or fail; this only
 * relabels which outcome bucket a run's result line lands in before scoring
 * happens, and it only ever narrows a `completed` or `crash` spawn outcome.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANTIGRAVITY_SIGNALS } from './providers/antigravity-signals.js';
import { CLAUDE_SIGNALS } from './providers/claude-signals.js';
import { CODEX_SIGNALS } from './providers/codex-signals.js';
import type { CliSignals } from './providers/signals.js';
import type { SpawnOutcome } from './score.js';

/** One CLI's infrastructure signals, keyed by the `cli` field the matrix uses. */
export const CLI_SIGNALS: Record<string, CliSignals> = {
  antigravity: ANTIGRAVITY_SIGNALS,
  claude: CLAUDE_SIGNALS,
  codex: CODEX_SIGNALS,
};

/** The outcomes `classifyOutcome` can return: a spawn outcome, or a refinement of one. */
export type RefinedOutcome = SpawnOutcome | 'interrupted' | 'bypassed';

function matchesAny(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Refine `spawn` using the CLI's captured stdout and stderr and the number of
 * MCP calls the event log recorded for the run. Only a `completed` or `crash`
 * spawn outcome is ever narrowed: a `timeout` is left alone, because the
 * process was killed before it could say anything about why, and an already
 * pacer-level `throttled` outcome never reached the CLI at all.
 */
export function classifyOutcome(
  cli: string,
  spawn: SpawnOutcome,
  stdout: string,
  stderr: string,
  callCount: number,
): RefinedOutcome {
  if (spawn !== 'completed' && spawn !== 'crash') return spawn;

  const signals = CLI_SIGNALS[cli];
  const combined = `${stdout}\n${stderr}`;

  const quotaSignaled = signals !== undefined && matchesAny(signals.throttled, combined);
  if (quotaSignaled) return 'throttled';

  const streamInterrupted = signals !== undefined && matchesAny(signals.interrupted, combined);
  const emptyResponseCrash = spawn === 'crash' && stdout.trim().length === 0;
  if (streamInterrupted || emptyResponseCrash) return 'interrupted';

  const builtinToolUsed = signals !== undefined && matchesAny(signals.builtinToolUse, stdout);
  if (spawn === 'completed' && callCount === 0 && builtinToolUsed) return 'bypassed';

  return spawn;
}

/** Read a run directory's captured stream, or the empty string when it was never written. */
function readCapturedStream(runDir: string, fileName: string): string {
  const path = join(runDir, fileName);
  if (!existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

/**
 * `classifyOutcome`, reading the CLI's captured `stdout.log` and `stderr.log`
 * out of a finished run directory rather than taking the text directly. Used
 * both by the runner right after a spawn and by the reporter when it re-derives
 * an archived run from its evidence.
 */
export function classifyRunOutcome(
  cli: string,
  spawn: SpawnOutcome,
  runDir: string,
  callCount: number,
): RefinedOutcome {
  const stdout = readCapturedStream(runDir, 'stdout.log');
  const stderr = readCapturedStream(runDir, 'stderr.log');
  return classifyOutcome(cli, spawn, stdout, stderr, callCount);
}
