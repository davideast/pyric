/**
 * `pyric-tools/deploy` — Firebase control-plane primitives + tool
 * factories. Pure-fetch over OAuth access tokens; works in browser
 * and Node alike. Service-account flow via `fromServiceAccount`;
 * browser hosts wrap Firebase Auth's `getIdToken`.
 *
 * See the design rationale,
 * conventions F1–F8.
 *
 *   - F1: Per-domain factories are the registry-facing API
 *         (`createXxxTools(deps) → ToolHandler[]`).
 *   - F2: Identity is a value; lifecycle is a resolver.
 *   - F3: `ProjectScope = { projectId, resolveToken }`.
 *   - F4: Resolvers fire per-dispatch; hosts memoize via
 *         `memoizeTtl` if cost matters.
 *   - F5: Handlers are self-contained (deps + args + ctx; no
 *         globals, no env, no module-level state).
 *   - F6: `registry.register` throws on conflict; `replace` for
 *         explicit overlays.
 *   - F7: Decoration via `.map` before `register`.
 *   - F8: `ToolContext` stays narrow (signal + optional
 *         session-scoped extras).
 *
 * Primitives at this root throw `AdminApiError` on non-2xx;
 * orchestrators return `Outcome`. The hosting + functions
 * sub-paths (existing) flatten into root namespaces in Slice 3.
 */

// ─── Foundation (Slice 1) ────────────────────────────────────────────

export type { ProjectScope, Outcome } from './scope.js';
export { AdminApiError } from './scope.js';
export { fromServiceAccount } from './from-service-account.js';
export { getDeploy } from './from-admin-app.js';
export { memoizeTtl, type MemoizeTtlOptions } from './memoize-ttl.js';
export { withResolvedScope } from './with-resolved-scope.js';

// ─── Named-object namespaces (Slice 3) ───────────────────────────────
//
// `hosting` and `functions` are the scope-shaped groupings consumers
// reach for. They wrap the existing portable primitives so every
// operation takes a ProjectScope and resolves the token internally
// per F4. The previous `pyric-tools/deploy/{hosting,functions}` sub-path
// exports are removed.

export { hosting, functions, firestore, recipes } from './namespaces.js';
export type { DeployHostingScopedOptions, DeployFunctionsLocalOptions } from './namespaces.js';

// ─── Firestore namespace types (Slice 4) ──────────────────────────────
export type {
  RuleCheckResult,
  EnsureRuleOutcome,
} from './firestore/rules.js';
export type {
  ProvisionDatabaseOptions,
  ProvisionDatabaseOutcome,
} from './firestore/databases.js';
export type {
  QueryScope,
  IndexFieldOrder,
  ArrayConfig,
  IndexState,
  ApiScope,
  Density,
  VectorConfig,
  IndexField,
  Index,
  IndexesConfigEntry,
  IndexesConfig,
  IndexOperation,
  DeployIndexesOptions,
  PerIndexOutcome,
  DeployIndexesOutcome,
  GetIndexStatusOutcome,
} from './firestore/indexes.js';

// ─── Portable primitive types — still useful for direct consumers ────
//
// These are the wire-shape types every namespace wrapper hands back.
// Exporting them at the root makes it possible to type a function's
// return without poking at the namespace export's inferred shape.

export type {
  DeployHostingResult,
  DeployHostingSuccess,
  DeployHostingError,
  HostingErrorCode,
} from './hosting/spec.js';
export type { DeployHostingFilesInput } from './hosting/core.js';
export type { WalkedFile } from './hosting/walk.js';
export type {
  CreateSiteResult,
  EnsureSiteResult,
  HostingSiteResource,
  CreateHostingSiteInput,
} from './hosting/sites.js';
export type {
  HostingJsonConfig,
  HostingRewriteJson,
  HostingRedirectJson,
  HostingHeaderJson,
  HostingSource,
} from './hosting/spec.js';
export type {
  DeployFunctionsResult,
  DeployFunctionsSuccess,
  DeployFunctionsError,
  DeployedFunction,
  FunctionsErrorCode,
  FunctionDeployConfig,
} from './functions/spec.js';

// ─── Pre-flight checks ───────────────────────────────────────────────
//
// Cheap GETs (~200ms total) the playground deploy runs up front so
// it can surface actionable remediation (missing IAM scopes,
// uninitialized Firestore, etc.) before kicking off the real
// hosting + rules + indexes work. See `preflight.ts`.

export {
  runPreflight,
  checkHostingSite,
  checkFirestoreDatabase,
  checkIamPermissions,
  type PreflightCheckId,
  type PreflightCheckResult,
  type PreflightOptions,
} from './preflight.js';

// ─── Tool factories (Slice 9) ────────────────────────────────────────
export {
  createFirestoreDeployTools,
  createHostingDeployTools,
  createFunctionsDeployTools,
  type ProjectScopedDeps,
  type DeployToolData,
} from './tools.js';
export type { DeployFunctionsCoreInput } from './functions/core.js';
export type { BundleResult, BundleOptions } from './functions/bundle.js';
export type { PollResult, PollOptions } from './functions/operation.js';
