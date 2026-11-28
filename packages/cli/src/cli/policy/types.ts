/**
 * Shared types, JSON schema contracts, and exit code constants for
 * `pyric policy <check|prove|emit>`.
 *
 * Structural interfaces mirror `@pyric/rules/experimental/policy` so
 * emitted CLI declarations do not add an undeclared package import edge.
 */
import type { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { PolicyExperimentalApi } from './api-types.js';

export type {
  PolicyExperimentalApi,
  RawCheckedFunction,
  RawCheckedPolicyIR,
  RawCompiledFunction,
  RawCompiledPolicy,
  RawFirestoreRow,
  RawProveReport,
  RawRtdbRow,
  RawStorageRow,
} from './api-types.js';

export const POLICY_EXIT_OK = 0;
export const POLICY_EXIT_USAGE = 1;
export const POLICY_EXIT_STATIC = 2;
export const POLICY_EXIT_PLACEMENT = 3;
export const POLICY_EXIT_PROOF = 4;

export type PolicyExitCode = 0 | 1 | 2 | 3 | 4;
export type PolicyProgramKind = 'transition' | 'function' | 'module';
export type PolicyMode = 'mixed' | 'complete';
export type PolicyTarget = 'standalone' | 'firestore' | 'storage' | 'rtdb';
export type PolicyCommandName = 'check' | 'prove' | 'emit';

export interface PolicySpan {
  line: number;
  col: number;
  location: string;
  excerpt?: string;
  inferred?: true;
}

export type PlacementReasonCode =
  | 'LOWERED'
  | 'USES_BOUNDED_OP'
  | 'USES_DERIVE'
  | 'USES_DERIVE_COLLECTION'
  | 'USES_HELPER_FUNCTIONS'
  | 'USES_LOCAL_BINDINGS'
  | 'MISSING_BINDING'
  | 'WRONG_SNAPSHOT_ORIGIN'
  | 'UNTRUSTED_DERIVE_INPUT'
  | 'PROJECTION_BUDGET_EXCEEDED'
  | 'EXPRESSION_BUDGET_EXCEEDED'
  | 'UNSUPPORTED_EXPRESSION'
  | 'UNVERIFIED_DERIVE_SIBLINGS'
  | 'INVALID_BINDING_PROJECTION'
  | 'LOOP_NOT_LOWERABLE';

export interface PlacementProblemDetail {
  code: PlacementReasonCode;
  message: string;
  detail?: string;
}

export interface BoundedOpCostDetail {
  op: string;
  limit: number;
  estimatedWorstCaseUnits: number;
}

export interface ExpressionCostBreakdown {
  sourceUnits: number;
  sourceLimit: number;
  targetUnits: number | null;
  targetLimit: number | null;
  withinSourceBudget: boolean;
  withinTargetBudget: boolean | null;
  letUnits: number;
  conditionUnits: number;
  boundedOps: BoundedOpCostDetail[];
}

export interface EvaluatedBindingTrace {
  name: string;
  scope: 'derive' | 'require';
  value?: unknown;
  error?: string;
  fatal?: true;
  span?: PolicySpan;
}

export interface SubExpressionOperandTrace {
  source: string;
  value?: unknown;
  error?: string;
}

export interface SubExpressionTrace {
  source: string;
  kind: string;
  operator?: string;
  value?: unknown;
  error?: string;
  operands?: SubExpressionOperandTrace[];
}

export interface PolicyFailureTrace {
  requirement: string;
  span: PolicySpan;
  source: string;
  outcome: 'false' | 'eval-error' | 'resource-limit';
  fatal: boolean;
  bindings: EvaluatedBindingTrace[];
  failingSubExpression?: SubExpressionTrace;
  derived?: Record<string, unknown> | { $error: string };
  expressionUnitsUsed: number;
  expressionLimit: number;
}

export type PolicyDiagnosticStage =
  | 'cli'
  | 'io'
  | 'parse'
  | 'static-check'
  | 'standalone'
  | 'placement'
  | 'emit'
  | 'scenario'
  | 'fuzz';

export type PolicyDiagnosticCode =
  | 'USAGE_ERROR'
  | 'IO_ERROR'
  | 'LOADER_ERROR'
  | 'SYNTAX_ERROR'
  | 'SOURCE_TOO_LARGE'
  | 'NESTING_LIMIT_EXCEEDED'
  | 'MISSING_EXTENSION'
  | 'UNKNOWN_EXTENSION'
  | 'RECURSIVE_CALL'
  | 'DUPLICATE_DECLARATION'
  | 'UNDECLARED_IDENTIFIER'
  | 'INVALID_LITERAL'
  | 'EXPRESSION_LIMIT_ERROR'
  | 'STATIC_CHECK_ERROR'
  | 'STANDALONE_EMIT_ERROR'
  | 'TARGET_LOWERING_ERROR'
  | 'TARGET_SKIPPED'
  | 'TEMPLATE_COMPOSE_ERROR'
  | 'SCENARIO_FAILURE'
  | 'PARITY_DIVERGENCE';

export interface PolicyCliDiagnostic {
  severity: 'error' | 'warning';
  code: PolicyDiagnosticCode;
  stage: PolicyDiagnosticStage;
  message: string;
  span: PolicySpan | null;
  target?: PolicyTarget;
  requirement?: string;
  scenario?: string;
}

export type FirestoreBindings = Readonly<Record<string, string>>;
export type StorageBindings = Readonly<Record<string, string>>;

export interface RtdbSnapshotBinding {
  snapshot: 'data' | 'newData';
  parent?: boolean;
  path?: string;
  type?: 'number' | 'string' | 'boolean' | 'any';
}

export type RtdbBinding = 'data' | 'newData' | RtdbSnapshotBinding;
export type RtdbBindings = Readonly<Record<string, RtdbBinding>>;

export interface FirestorePlacement {
  path: string;
  operation: 'create' | 'update' | 'delete';
  bindings: FirestoreBindings;
}

export interface FirestoreTemplate {
  rules: string;
  slot: string;
  placements: readonly FirestorePlacement[];
}

export interface StoragePlacement {
  path: string;
  operation: string;
  bindings: StorageBindings;
}

export interface StorageTemplate {
  rules: string;
  slot: string;
  placements: readonly StoragePlacement[];
}

export interface TransitionInput {
  before: unknown;
  after: unknown;
  input: unknown;
}

export interface ProvePolicyScenario {
  name: string;
  transition?: TransitionInput;
  functionName?: string;
  args?: unknown[];
  expectOk?: boolean;
  expectRequirement?: string;
  expectValue?: unknown;
  expectError?: boolean;
}

export interface ProvePolicyFuzzOptions {
  enabled?: boolean;
  seed?: number;
  cases?: number;
  includeAdversarial?: boolean;
  maxDurationMs?: number;
}

export interface ProveDivergence {
  caseIndex: number;
  input: unknown;
  interpreter: unknown;
  standalone: unknown;
  firestore?: string;
  rtdb?: string;
}

export interface TargetPlacementRow {
  requirement: string;
  location: string;
  span: PolicySpan;
  source: string;
  enforcement: string;
  lowered: boolean;
  reason: string;
  completeReason?: string;
  predicate?: string;
  features: string[];
  inputs: string[];
  origins?: Record<string, string>;
  bindings: Record<string, unknown>;
  diagnostics: PlacementProblemDetail[];
  cost: ExpressionCostBreakdown;
}

export interface TargetPlacementReport {
  target: 'firestore' | 'storage' | 'rtdb';
  complete: boolean;
  summary: {
    total: number;
    lowered: number;
    residual: number;
    loweredRequirements: string[];
    residualRequirements: string[];
  };
  rows: TargetPlacementRow[];
}

export interface FunctionPlacementItem {
  name: string;
  exported: boolean;
  parameters: string[];
  span: PolicySpan | null;
  cost: ExpressionCostBreakdown;
  firestoreLowerable?: boolean;
  firestoreReason?: string;
  firestoreDiagnostics?: PlacementProblemDetail[];
  rtdbLowerable?: boolean;
  rtdbReason?: string;
}

export interface PolicyPlacementSummary {
  firestore?: TargetPlacementReport;
  storage?: TargetPlacementReport;
  rtdb?: TargetPlacementReport;
  functions?: FunctionPlacementItem[];
}

export interface PolicyCostItem {
  name: string;
  kind: 'requirement' | 'function';
  span: PolicySpan | null;
  cost: ExpressionCostBreakdown;
}

export interface PolicyTargetCostSummary {
  totalTargetUnits: number | null;
  targetLimit: number | null;
  withinTargetBudget: boolean | null;
}

export interface PolicyCostSummary {
  expressionLimit: number;
  totalSourceUnits: number;
  maxItemUnits: number;
  withinSourceBudget: boolean;
  boundedOps: Array<BoundedOpCostDetail & { owner: string }>;
  items: PolicyCostItem[];
  byTarget: {
    firestore?: PolicyTargetCostSummary;
    storage?: PolicyTargetCostSummary;
    rtdb?: PolicyTargetCostSummary;
  };
}

export interface StaticCheckSummary {
  ok: boolean;
  extensions: string[];
  functions: string[];
  topoOrder: string[];
  exports: string[];
  requirements: string[];
  transitionName: string | null;
  hasDerive: boolean;
  acyclic: boolean;
  expressionLimit: number;
}

export interface StandaloneSummary {
  ok: boolean;
  exports: string[];
  moduleBytes: number;
  esmVerified?: boolean;
  error?: string;
}

export interface PolicyCheckReport {
  schema: 'pyric.policy.check.v1';
  command: 'check';
  ok: boolean;
  exitCode: PolicyExitCode;
  file: string;
  kind: PolicyProgramKind | null;
  mode: PolicyMode;
  staticCheck: StaticCheckSummary;
  diagnostics: PolicyCliDiagnostic[];
  placement: PolicyPlacementSummary;
  cost: PolicyCostSummary;
  standalone: StandaloneSummary;
}

export interface PolicyProveScenarioItem {
  name: string;
  ok: boolean;
  parityOk: boolean;
  interpreter: unknown;
  standalone: unknown;
  firestore?: string;
  rtdb?: string;
  mismatch?: string;
  failureTrace?: PolicyFailureTrace;
}

export interface PolicyCounterexample {
  source: 'scenario' | 'fuzz';
  name?: string;
  caseIndex?: number;
  mismatch: string;
  input?: unknown;
  requirement?: string;
  span?: PolicySpan;
  reason?: string;
  trace?: PolicyFailureTrace;
  interpreter: unknown;
  standalone: unknown;
  firestore?: string;
  rtdb?: string;
}

export interface PolicyProveReport {
  schema: 'pyric.policy.prove.v1';
  command: 'prove';
  ok: boolean;
  exitCode: PolicyExitCode;
  file: string;
  kind: PolicyProgramKind | null;
  mode: PolicyMode;
  staticCheck: StaticCheckSummary;
  diagnostics: PolicyCliDiagnostic[];
  standalone: StandaloneSummary;
  placement: PolicyPlacementSummary;
  cost: PolicyCostSummary;
  scenarios: {
    total: number;
    passed: number;
    failed: number;
    results: PolicyProveScenarioItem[];
  };
  fuzz: {
    enabled: boolean;
    seed: number;
    casesRequested: number;
    casesRun: number;
    passed: number;
    failed: number;
    divergences: ProveDivergence[];
  };
  counterexamples: PolicyCounterexample[];
}

export type EmittedArtifactFormat =
  | 'esm'
  | 'firestore-module'
  | 'firestore-rules'
  | 'storage-module'
  | 'storage-rules'
  | 'rtdb-rules-json';

export interface EmittedArtifact {
  target: PolicyTarget;
  format: EmittedArtifactFormat;
  fileName: string;
  path: string | null;
  written: boolean;
  bytes: number;
  sha256: string;
  exports?: string[];
  complete?: boolean;
  loweredRequirements?: string[];
  residualRequirements?: string[];
  partialRequirements?: string[];
  rtdbPath?: string;
  predicate?: string;
}

export interface PolicyEmitReport {
  schema: 'pyric.policy.emit.v1';
  command: 'emit';
  ok: boolean;
  exitCode: PolicyExitCode;
  file: string;
  kind: PolicyProgramKind | null;
  mode: PolicyMode;
  name: string | null;
  outDir: string | null;
  dryRun: boolean;
  targets: PolicyTarget[];
  manifestPath: string | null;
  staticCheck: StaticCheckSummary;
  diagnostics: PolicyCliDiagnostic[];
  standalone: StandaloneSummary;
  placement: PolicyPlacementSummary;
  cost: PolicyCostSummary;
  artifacts: EmittedArtifact[];
}

export interface PolicyUsageErrorReport {
  schema: 'pyric.policy.v1' | `pyric.policy.${PolicyCommandName}.v1`;
  command: PolicyCommandName | null;
  ok: false;
  exitCode: 1;
  file: string | null;
  diagnostics: PolicyCliDiagnostic[];
}

export interface PolicyCliDeps {
  readonly cwd?: string;
  readonly stdout?: { write(s: string): void };
  readonly stderr?: { write(s: string): void };
  readonly readStdin?: () => Promise<string>;
  readonly readFile?: typeof readFile;
  readonly writeFile?: typeof writeFile;
  readonly mkdir?: typeof mkdir;
  readonly loadPolicyApi?: () => Promise<PolicyExperimentalApi>;
  readonly verifyStandaloneEsm?: (
    moduleSource: string,
    expectedExports: readonly string[],
  ) => Promise<void>;
}
