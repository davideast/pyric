/**
 * The deploy provider contract — a small descriptor, not a framework.
 *
 * Each Firebase product (`functions`, `hosting`, `storage`, …) is one
 * {@link DeployProvider}. The CLI dispatcher and the agent tool-registry both
 * derive from the provider registry, so target identity has ONE source of truth.
 *
 * What the contract makes polymorphic is ONLY what dispatch actually varies on:
 *   1. how to READ a target's config from firebase.json + flags ({@link resolveConfig});
 *   2. how to TURN a scope into the runnable {@link ToolHandler}s ({@link tools}).
 *
 * Everything else is shared and stays put: token resolution rides
 * `ProjectScope.resolveToken()`, network is global `fetch` inside the existing
 * primitives, exit codes (0 ok / 1 usage / 2 runtime) live in the dispatcher,
 * and the multi-step lifecycle (preflight/plan/apply) stays INSIDE each handler.
 * This is deliberate — modeling the lifecycle as contract methods, or unifying
 * the providers' internal outcome dialects, would be over-engineering: the tool
 * boundary already normalizes every result to `{ ok, summary, data }`.
 */

import type { ToolHandler, ToolContext } from '@inbrowser/agent';
import type { ProjectScope } from './scope.js';
import type { FirebaseJson, FirebaseRc } from '../cli/firebase-json.js';

/**
 * Live progress narration emitted by a provider during a deploy. Purely
 * additive: a handler that never calls `ctx.report` behaves exactly as before,
 * and deleting every `report()` call leaves behavior byte-identical. Exit codes
 * derive from the terminal {@link ToolResult}, never from these events.
 */
export interface DeployProgressEvent {
  /** The {@link DeployProvider.target} this event belongs to. */
  target: string;
  /** Stable machine id for the step, e.g. `'enable-service' | 'settle' | 'upload' | 'release'`. */
  step: string;
  status: 'start' | 'progress' | 'done' | 'skip' | 'fail';
  /** One human line, same register as `ToolResult.summary`. */
  message: string;
  /** 0..1 — emit ONLY when a real denominator exists. Omit for indeterminate
   *  waits (e.g. a propagation sleep) so the UI shows a spinner, never a fake bar. */
  pct?: number;
  /** Optional structured payload (bucketId, versionName, …) for machine sinks. */
  data?: unknown;
}

/**
 * The target-less event a HANDLER emits. The dispatcher stamps `target` (it
 * knows which provider is running) and forwards the full
 * {@link DeployProgressEvent} to the board / NDJSON sink, so a handler never has
 * to know — or hardcode — its own target name. (This is what lets a tool that is
 * also a plain agent tool emit progress without depending on deploy concepts.)
 */
export type DeployStepEvent = Omit<DeployProgressEvent, 'target'>;

/** A handler emits progress through this callback (absent on the agent path). */
export type DeployReport = (event: DeployStepEvent) => void;

/**
 * Deploy-local extension of the (intentionally narrow) agent {@link ToolContext}.
 * The agent runtime never sets `report`, so the agent path no-ops; the CLI
 * dispatcher injects a reporter that drives the status board / NDJSON sink.
 */
export interface DeployToolContext extends ToolContext {
  report?: DeployReport;
}

/**
 * The environment a provider reads its config from. This is the HONEST surface:
 * resolving config is not pure — hosting needs `.firebaserc` + the git branch,
 * functions reads flags and ignores firebase.json — so the source carries all of
 * it. `projectId` is already resolved (scope is resolved before config).
 */
export interface ConfigSource {
  firebaseJson: FirebaseJson;
  firebaseRc: FirebaseRc | null;
  flags: ReadonlyMap<string, string | boolean>;
  projectId: string;
  cwd: string;
  readFile(path: string): Promise<string>;
  getGitBranch(): Promise<string | null>;
}

/**
 * The result of resolving config: zero-or-more units to execute (PLURAL — a
 * hosting deploy fans out over sites, a storage deploy over buckets), or a usage
 * error. A usage error is fail-fast: the dispatcher prints it and exits 1 BEFORE
 * any network call.
 */
export type ResolveResult<A> =
  | { ok: true; units: A[]; warnings?: string[] }
  | { ok: false; message: string };

/**
 * One verb of a provider. Most providers have a single default op; multi-verb
 * providers (e.g. storage = provision; firestore = rules | indexes) expose
 * several, selected via `deploy <target>:<op>`.
 */
export interface DeployOperation {
  /** Sub-target name, dispatched as `deploy <target>:<name>`. */
  name: string;
  /** The op run by a bare `deploy <target>`. Exactly one should be default. */
  default?: boolean;
  /** The {@link ToolHandler} name this op dispatches to. */
  toolName: string;
  /** Marks an irreversible op; reserved for a future `--force` gate (convention
   *  now so destructive steps never read stdin from inside a handler). */
  destructive?: boolean;
}

/**
 * A deploy target. Adding one is this descriptor plus one registry line.
 * `A` is the per-unit argument type produced by {@link resolveConfig} and fed to
 * the handler's `execute` — keeping the two in lockstep.
 */
export interface DeployProvider<A = unknown> {
  readonly target: string;
  /** One-liner for generated help text. */
  readonly summary: string;
  readonly operations: readonly DeployOperation[];
  /** The OAuth scope this target needs. Drives the login scope-upgrade preflight:
   *  a logged-in user lacking it is prompted to re-authorize before dispatch. */
  readonly requiredScope: string;
  /** The Google APIs this target needs enabled on the project. The deploy
   *  preflight ensures these are enabled (auto-enable when the caller has
   *  permission; otherwise print a console link and fail fast) before any
   *  mutation. See design rationale */
  readonly requiredApis: readonly string[];
  /** The provider's runnable tools for a scope — the existing factory, unchanged. */
  tools(scope: ProjectScope): ToolHandler<A>[];
  /** Read this op's config from firebase.json + flags into execute args (plural). */
  resolveConfig(op: string, src: ConfigSource): Promise<ResolveResult<A>>;
}
