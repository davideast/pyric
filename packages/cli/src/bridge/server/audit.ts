/**
 * Audit log writer. Every sandbox bridge tool call appends
 * one JSON line to the project's events.ndjson file.
 *
 * Audit events land at the project's conventional location:
 *   `~/.pyric/projects/<projectId>/events.ndjson`
 *
 * The bridge passes its `BridgeToolEvent` here through `onToolEvent`.
 * Writes are best-effort — failure to log must not break tool
 * dispatch.
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, appendFileSync } from 'node:fs';
import type { BridgeToolEvent, BridgeToolEventRun } from './bridge.js';

export interface AuditWriter {
  write(event: BridgeToolEvent): void;
  /** Filesystem path of the active log. */
  readonly path: string;
}

export function createAuditWriter(project: string): AuditWriter {
  const dir = join(homedir(), '.pyric', 'projects', sanitiseProjectId(project));
  const path = join(dir, 'events.ndjson');
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    // If we can't create the directory, fall back to silent no-op.
    return {
      write: () => {},
      path,
    };
  }
  return {
    path,
    write(event: BridgeToolEvent) {
      try {
        const line = JSON.stringify(event) + '\n';
        appendFileSync(path, line, { encoding: 'utf8' });
      } catch {
        // Drop the entry; tool dispatch continues.
      }
    },
  };
}

function sanitiseProjectId(value: string): string {
  // Project ids are normally alphanumeric + dash; defend against
  // path traversal just in case (someone passes `../etc` etc.).
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128) || 'unknown';
}

// Evaluation log writer.
//
// A second writer, used only by the headless server during a tool-surface
// evaluation. It writes to a caller-named file rather than the per-project
// audit location, and it completes each event with the fields the scorer reads:
// the run envelope, the call index, and the operation and action the surface
// resolved. The project audit writer above is unaffected.

/** The run identity shared by every event in one evaluation run. */
export type EvalRunIdentity = Omit<BridgeToolEventRun, 'callIndex'>;

/** Environment variables that carry the run identity into the server process. */
const EVAL_RUN_ENV_KEYS = {
  runId: 'PYRIC_EVAL_RUN_ID',
  taskId: 'PYRIC_EVAL_TASK_ID',
  variant: 'PYRIC_EVAL_VARIANT',
  cli: 'PYRIC_EVAL_CLI',
  model: 'PYRIC_EVAL_MODEL',
  effort: 'PYRIC_EVAL_EFFORT',
  condition: 'PYRIC_EVAL_CONDITION',
} as const;

/** Environment variable naming the evaluation log file. */
export const EVAL_LOG_ENV_KEY = 'PYRIC_EVAL_LOG';

/** Environment variable carrying the numeric seed. */
export const EVAL_SEED_ENV_KEY = 'PYRIC_EVAL_SEED';

/**
 * Read the run identity from the environment. Every string field defaults to
 * the empty string and the seed to zero, so a run started without the full set
 * still produces well-formed lines.
 */
export function readEvalRunIdentity(env: NodeJS.ProcessEnv = process.env): EvalRunIdentity {
  const seedText = env[EVAL_SEED_ENV_KEY];
  let seed = 0;
  if (seedText !== undefined && seedText.trim() !== '') {
    const parsedSeed = Number(seedText);
    if (Number.isFinite(parsedSeed)) seed = parsedSeed;
  }
  return {
    runId: env[EVAL_RUN_ENV_KEYS.runId] ?? '',
    taskId: env[EVAL_RUN_ENV_KEYS.taskId] ?? '',
    variant: env[EVAL_RUN_ENV_KEYS.variant] ?? '',
    cli: env[EVAL_RUN_ENV_KEYS.cli] ?? '',
    model: env[EVAL_RUN_ENV_KEYS.model] ?? '',
    effort: env[EVAL_RUN_ENV_KEYS.effort] ?? '',
    condition: env[EVAL_RUN_ENV_KEYS.condition] ?? '',
    seed,
  };
}

/**
 * Create the evaluation log writer. Each event is completed and appended as one
 * NDJSON line at `path`. `callIndex` counts calls from zero within this process.
 * Writes are best-effort, like the audit writer: a failure drops the line and
 * tool dispatch continues.
 */
export function createEvalLogWriter(path: string, run: EvalRunIdentity): AuditWriter {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Without a directory there is nowhere to append; log nothing rather than
    // failing every tool call.
    return { write: () => {}, path };
  }
  let callIndex = 0;
  return {
    path,
    write(event: BridgeToolEvent) {
      const line = completeEvalEvent(event, run, callIndex);
      callIndex += 1;
      try {
        appendFileSync(path, JSON.stringify(line) + '\n', { encoding: 'utf8' });
      } catch {
        // Drop the entry; tool dispatch continues.
      }
    },
  };
}

/**
 * Fill in the fields the scorer requires but an upstream writer may have left
 * absent. `operation` and `action` stay null unless the surface resolved them.
 */
function completeEvalEvent(
  event: BridgeToolEvent,
  run: EvalRunIdentity,
  callIndex: number,
): BridgeToolEvent {
  let isError = !event.result.ok;
  if (event.isError !== undefined) isError = event.isError;
  return {
    ...event,
    operation: event.operation ?? null,
    action: event.action ?? null,
    schemaRejected: event.schemaRejected ?? false,
    isError,
    verdict: event.verdict ?? false,
    run: { ...run, callIndex },
  };
}
