import type { AiEngineConfigWire } from './worker/protocol.js';

/** A Realtime Database ruleset as `database.rules.json` holds it. */
export type RtdbRulesJson = { rules: Record<string, unknown> };

/** The Realtime Database instances a project deploys rules to, read as the Firebase CLI reads `firebase.json`. */
export interface DatabaseInstancesRules {
  /** The instance `getDatabase()` selects without a URL. */
  defaultInstance: string;
  /** Each declared instance's rules, keyed by instance name; null while its rules file does not exist. */
  rules: Record<string, RtdbRulesJson | null>;
  /** `firebase.json` target entries no project resolved when the server started. */
  pendingTargets?: PendingDatabaseTargetRules[];
}

/** Where a database ruleset deploys: an instance name, absent for the
 *  default instance, or an unresolved deploy target. */
export type DatabaseRulesDestination = string | { target: string };

/**
 * A `firebase.json` deploy target the server could not map to instances,
 * because no project was set or the project does not map it. The sandbox
 * applies its rules once the page's app config names a project.
 */
export interface PendingDatabaseTargetRules {
  /** The deploy target name. */
  target: string;
  /** The target's rules; null while its rules file does not exist. */
  rules: RtdbRulesJson | null;
  /** The instance names `.firebaserc` maps the target to, by project id. */
  instancesByProject: Record<string, string[]>;
}

/** Browser-safe wire contract served by `/__pyric/init.json`. */
export interface InitPayload {
  /** Per-server capability for the warning-only activity report endpoint. */
  activityToken?: string;
  /** Per-boot session capability token required on workspace and project endpoints. */
  sessionToken?: string;
  rules: string | null;
  rulesHash: string | null;
  /** The default instance's Realtime Database rules, for consumers that serve one database. */
  databaseRules?: RtdbRulesJson | null;
  databaseRulesHash?: string | null;
  /** Every Realtime Database instance `firebase.json` deploys rules to, with its rules. */
  databaseInstances?: DatabaseInstancesRules | null;
  /** Explicit opt-in to permissive default access when rules are unconfigured. */
  permissive?: boolean;
  /** Storage rules installed before the first Storage operation. A dev server
   *  replaces them over `storage-rules-update` when the rules file changes. */
  storageRules: string | null;
  storageRulesHash: string | null;
  /**
   * Local project identity — the served project directory. Scopes the
   * storage IndexedDB database name (`pyric-storage:<projectKey>`, issue
   * #359): IndexedDB is origin-scoped, so without this every project served
   * on one localhost port shared one storage database. Local-only (a dev
   * server path never leaves the machine). Absent/null on older servers —
   * consumers fall back to the legacy shared name.
   */
  projectKey?: string | null;
  bridgeUrl: string | null;
  /** Explicit Node ownership; browser startup must not select a local store. */
  hosted?: boolean;
  persistenceUnhealthy?: boolean;
  seed: Record<string, Record<string, unknown>> | null;
  persist?: boolean;
  seedState?: unknown | null;
  authUsers?: ReadonlyArray<Record<string, unknown>> | null;
  capture?: boolean;
  messaging?: boolean;
  /**
   * True exactly when `/__pyric/assets/avatar/<uid>` is mounted (`avatars`
   * was not explicitly disabled — see `avatars-config.ts`). Only this flag
   * travels to the page; the resolved set directory or source never does,
   * mirroring the AI proxy's server-only-config asymmetry. A browser
   * consumer that backfills `photoURL` from this flag is a later task.
   */
  avatars?: boolean;
  /**
   * True exactly when this server's avatars config carries a `source`, the
   * only configuration whose images can arrive after the first request: a
   * generated image supersedes the placeholder the browser was served while
   * it ran. `avatars` says the route is mounted; this says an upgrade is
   * possible at all. The page decides on this flag whether to open a
   * listener, so the default and set-only configurations — final on the first
   * request — open no connection.
   */
  avatarUpgrades?: boolean;
  /**
   * Plugin-level AI config (`@pyric/cli/vite`'s `ai.engine`). Only the ENGINE
   * travels here — the OpenAI proxy upstream is a server-side namespace option
   * that never reaches the page. The worker host reads `ai.engine` into
   * `ctx.aiEngine`, which wins over any op-carried `engine` (see host-ai.ts).
   * Absent under `pyric dev` (no CLI surface) and whenever the plugin sets no
   * engine. The in-page fallback path receives the same engine synchronously
   * via the injected `globalThis.__PYRIC_AI_ENGINE__` (init.json can't be read
   * synchronously by the served `getAI`).
   */
  ai?: { engine?: AiEngineConfigWire } | null;
}

/** Synchronous page transport selection, injected before application modules. */
export type WorkerInitPayload = Pick<InitPayload, 'hosted' | 'projectKey' | 'bridgeUrl' | 'persistenceUnhealthy'>;

declare global {
  var __PYRIC_WORKER_INIT__: WorkerInitPayload | undefined;
}
