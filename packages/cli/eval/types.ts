/**
 * Shared types for the tool-surface evaluation. These are the contract shapes
 * from sections 4 to 6 of CONTRACT.md, declared once so the corpus, the matrix,
 * the runner, the scorer, and the reporter agree without importing each other's
 * implementations.
 */

import type { SandboxSeed } from '../src/bridge/surface/seed-apply.js';

/**
 * State loaded into the sandbox before a run starts. Tasks never seed by tool
 * call. This is the same declaration the `sandbox.seed` method validates
 * against, not a second copy of its fields, so a task's seed and an agent's
 * own seed call cannot drift apart.
 */
export type EvalSeed = SandboxSeed;

/** One recorded tool call, read back from the events NDJSON. */
export interface EvalCall {
  operation: string | null;
  tool: string;
  ok: boolean;
  schemaRejected: boolean;
}

/** The final sandbox snapshot plus the call log, as a task's `assert` sees it. */
export interface EvalState {
  firestore: {
    get(path: string): Record<string, unknown> | null;
    list(collection: string): Array<{ id: string; data: Record<string, unknown> }>;
  };
  database: { get(path: string): unknown };
  users: {
    get(uid: string): {
      uid: string;
      email?: string;
      claims: Record<string, unknown>;
      tenant?: string;
    } | null;
    list(): Array<{ uid: string }>;
  };
  storage: {
    get(path: string): { contentType?: string; size: number; metadata: Record<string, unknown> } | null;
  };
  calls: EvalCall[];
}

/** One corpus record. The default export of `corpus/<task-id>.ts`. */
export interface EvalTask {
  /** Equals the filename without extension. */
  id: string;
  /** What the agent is asked, in user words. */
  prompt: string;
  /** State loaded before the run. */
  seed: EvalSeed;
  /** Canonical operation ids; an empty array means any first operation is accepted. */
  acceptedFirstOperations: string[];
  /** True when the task succeeded, otherwise a short reason. */
  assert: (state: EvalState) => true | string;
  tags: string[];
}

/** One matrix record. The default export of `matrix/<row-id>.ts`. */
export interface EvalRow {
  /** Equals the filename without extension. */
  id: string;
  cli: 'claude' | 'codex' | 'antigravity';
  /** The model slug as that CLI spells it. */
  model: string;
  /** Omitted for antigravity, where the effort lives in the slug. */
  effort?: string;
  /** `mcp-only` is valid only for cli `claude`. */
  condition: 'agent-default' | 'mcp-only';
  seeds: number[];
}

/** Everything one spawned process needs, resolved before the provider is asked. */
export interface EvalRun {
  runId: string;
  row: EvalRow;
  variant: string;
  task: EvalTask;
  seed: number;
  /**
   * Absolute run directory, under the results tree. Holds the raw output, the
   * provider config files the CLI is handed by path, and, once the process has
   * exited, the copies of the state the run produced. The CLI is never started
   * here and is never told this path.
   */
  dir: string;
  /**
   * Absolute directory the CLI is started in, and the only directory a provider
   * that takes a directory flag is allowed to name. It holds nothing but the
   * files a provider must place there, so a built-in file tool finds no state.
   */
  workspaceDir: string;
  /**
   * Absolute directory the seeder writes and the headless server is pointed at,
   * outside the results tree entirely. Copied into `dir` after the run and then
   * deleted.
   */
  stateDir: string;
  /** Absolute path of the NDJSON events file, exported as `PYRIC_EVAL_LOG`. */
  eventsPath: string;
  /** The MCP server command the CLI is configured to spawn. */
  serverCommand: string[];
  /** Repository root, used to resolve the local build. */
  repoRoot: string;
  /**
   * Canned calls for the fake provider. A harness property rather than a corpus
   * property, so it rides on the run and never on the task record.
   */
  fakeTranscript?: Array<{ tool: string; args: Record<string, unknown> }>;
}

/**
 * What a provider module returns.
 *
 * `files` are written relative to the run directory and `workspaceFiles`
 * relative to the workspace. A provider puts a file in the workspace only when
 * the CLI can find it no other way; everything a CLI accepts as a path belongs
 * in the run directory, out of the agent's reach.
 */
export interface Invocation {
  command: string[];
  env: Record<string, string>;
  files: Record<string, string>;
  workspaceFiles: Record<string, string>;
}

/** A provider module's single export. */
export type BuildInvocation = (run: EvalRun) => Invocation;

/**
 * `throttled`, `interrupted` and `bypassed` are infrastructure and bypass
 * outcomes rather than a verdict on the task: a quota refusal, a stream cut
 * off mid-run, or a run that touched the sandbox through the agent's own file
 * tools instead of the surface under test. The reporter counts them
 * separately and excludes them from the completion denominator.
 */
export type EvalOutcome =
  | 'pass'
  | 'fail'
  | 'timeout'
  | 'throttled'
  | 'crash'
  | 'interrupted'
  | 'bypassed';

/** One line of `results/<runId>/runs.ndjson`. */
export interface EvalResultLine {
  runId: string;
  row: string;
  variant: string;
  task: string;
  seed: number;
  outcome: EvalOutcome;
  firstOperation: string | null;
  firstOperationAccepted: boolean;
  /** Whether any logged call, not just the first, reached an accepted operation. */
  acceptedOpReached: boolean;
  callCount: number;
  schemaRejections: number;
  errorCalls: number;
  durationMs: number;
  assertReason: string | null;
}

/** One line of the events NDJSON the headless server writes. */
export interface EvalEvent {
  timestamp: string;
  mode: string;
  project: string;
  tool: string;
  operation: string | null;
  action: string | null;
  args: Record<string, unknown>;
  result: { ok: boolean; summary: string; data?: unknown };
  durationMs: number;
  schemaRejected: boolean;
  isError: boolean;
  run: {
    runId: string;
    taskId: string;
    variant: string;
    cli: string;
    model: string;
    effort: string;
    condition: string;
    seed: number;
    callIndex: number;
  };
}
