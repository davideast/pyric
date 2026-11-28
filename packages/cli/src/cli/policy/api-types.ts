/**
 * Structural TypeScript mirror of `@pyric/rules/experimental/policy`.
 * Kept separate so emitted `@pyric/cli` declarations contain zero undeclared
 * package import edges.
 */
import type {
  ExpressionCostBreakdown,
  FirestoreBindings,
  FirestoreTemplate,
  PlacementProblemDetail,
  PolicyMode,
  PolicyProgramKind,
  PolicySpan,
  ProveDivergence,
  ProvePolicyFuzzOptions,
  ProvePolicyScenario,
  RtdbBindings,
  StorageBindings,
  StorageTemplate,
} from './types.js';

export interface RawCheckedFunction {
  fn: {
    name: string;
    parameters: string[];
    exported: boolean;
    lets: Array<{ name: string; value: unknown; loc?: { line: number; col: number } }>;
    body: unknown;
    loc?: { line: number; col: number };
  };
}

export interface RawCheckedPolicyIR {
  program: {
    kind: PolicyProgramKind;
    transition?: {
      name: string;
      derivation?: unknown;
      requirements: Array<{
        name: string;
        location: string;
        source: string;
        loc?: { line: number; col: number };
      }>;
    };
  };
  expressionLimit: number;
  extensions: ReadonlySet<string>;
  functions: ReadonlyMap<string, RawCheckedFunction>;
  topoOrder: readonly string[];
  exports: readonly string[];
  requirementNames: readonly string[];
}

export interface RawFirestoreRow {
  requirement: string;
  location: string;
  span: PolicySpan;
  source: string;
  features: string[];
  inputs: string[];
  origins: Record<string, string>;
  bindings: Record<string, unknown>;
  enforcement: string;
  reason: string;
  completeReason?: string;
  diagnostics: PlacementProblemDetail[];
  cost: ExpressionCostBreakdown;
  predicate?: string;
}

export interface RawStorageRow {
  requirement: string;
  location: string;
  source: string;
  features: string[];
  inputs: string[];
  origins: Record<string, string>;
  bindings: Record<string, unknown>;
  enforcement: string;
  reason: string;
  completeReason?: string;
  predicate?: string;
}

export interface RawRtdbRow {
  requirement: string;
  span: PolicySpan;
  source: string;
  features: string[];
  inputs: string[];
  bindings: Record<string, unknown>;
  enforcement: string;
  reason: string;
  diagnostics: PlacementProblemDetail[];
  cost: ExpressionCostBreakdown;
  predicate?: string;
}

export interface RawCompiledPolicy {
  ir: RawCheckedPolicyIR;
  standaloneModule(): { target: 'standalone'; moduleSource: string; exports: string[] };
  firestore(bindings: FirestoreBindings, mode?: PolicyMode): RawFirestoreRow[];
  storage(bindings: StorageBindings, mode?: PolicyMode): RawStorageRow[];
  rtdb(bindings: RtdbBindings, mode?: PolicyMode): RawRtdbRow[];
  firestoreModule(bindings: FirestoreBindings): string;
  storageModule(bindings: StorageBindings): string;
  bind: {
    firestore(template: FirestoreTemplate): { rules: string; placements: unknown[] };
    storage(template: StorageTemplate): { rules: string; placements: unknown[] };
    rtdb(placement: { path: string; bindings: RtdbBindings; mode?: PolicyMode }): {
      verify(rules: { rules: unknown }): void;
    };
  };
}

export interface RawCompiledFunction {
  ir: RawCheckedPolicyIR;
  standaloneModule(): { target: 'standalone'; moduleSource: string; exports: string[] };
  placement(): {
    name: string;
    target: 'Firestore' | 'standalone';
    firestoreLowerable: boolean;
    reason: string;
    diagnostics: PlacementProblemDetail[];
    cost: ExpressionCostBreakdown;
  };
  firestoreModule(): string;
  rtdbPredicate(bindings: RtdbBindings): string;
}

export interface RawProveReport {
  ok: boolean;
  kind: PolicyProgramKind;
  staticCheck: {
    ok: boolean;
    error?: string;
    extensions: string[];
    functions: string[];
    topoOrder: string[];
    exports: string[];
    requirements: string[];
    hasDerive: boolean;
    acyclic: boolean;
    expressionLimit: number;
  };
  standalone: {
    ok: boolean;
    exports: string[];
    moduleBytes: number;
    error?: string;
  };
  scenarios: {
    total: number;
    passed: number;
    failed: number;
    results: Array<{
      name: string;
      ok: boolean;
      parityOk: boolean;
      interpreter: unknown;
      standalone: unknown;
      firestore?: string;
      rtdb?: string;
      mismatch?: string;
    }>;
  };
  fuzz: {
    enabled: boolean;
    seed: number;
    casesRun: number;
    passed: number;
    divergences: ProveDivergence[];
  };
}

export interface PolicyExperimentalApi {
  detectPolicyKind(source: string): PolicyProgramKind;
  parsePolicyIR(source: string, kind: PolicyProgramKind): unknown;
  checkPolicyIR(ir: unknown, options?: { expressionLimit?: number }): RawCheckedPolicyIR;
  emitStandaloneModule(checked: RawCheckedPolicyIR): {
    target: 'standalone';
    moduleSource: string;
    exports: string[];
  };
  compilePolicy(source: string, options?: { expressionLimit?: number }): RawCompiledPolicy;
  compileFunction(source: string, options?: { expressionLimit?: number }): RawCompiledFunction;
  emitStorageModule(
    name: string,
    rows: readonly { requirement: string; predicate?: string }[],
  ): string;
  provePolicy(
    source: string,
    options?: {
      kind?: PolicyProgramKind;
      expressionLimit?: number;
      firestore?: FirestoreBindings;
      rtdb?: RtdbBindings;
      scenarios?: readonly ProvePolicyScenario[];
      fuzz?: ProvePolicyFuzzOptions;
    },
  ): RawProveReport;
}
