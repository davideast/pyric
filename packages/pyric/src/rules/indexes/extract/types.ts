/**
 * Types for the Layer-1 static query extractor.
 *
 * The extractor walks TypeScript/JavaScript source, finds Firestore
 * `query(...)` chains (modular API), enumerates the conditional branches
 * that may produce them, and emits one or more `QueryShape` per call site.
 * Composite-index detection then reduces those shapes to an
 * `IndexesConfig`-shaped output the deploy handler can consume directly.
 *
 * No logic in this file — these are the data contracts that the rest of
 * the extract/ modules pass around.
 */

import type { IndexesConfig } from '../types.js';
import type { Annotations, AnnotationWarning } from './annotations.js';

export type { Annotations, AnnotationWarning } from './annotations.js';

/**
 * Per-function summary of which annotations applied during enumeration
 * and how many shapes each pruned. Surfaced in `ExtractResult.data` so
 * the agent can see whether its annotations had the intended effect.
 */
export interface AnnotationApplied {
  /**
   * The function the prune effect attributes to. For caller-owned
   * annotations this is the function whose leading comment block carries
   * them. For annotations on a wrapper that was inlined into a caller
   * (Layer 2.5), this is the **caller** — the function whose enumerated
   * shapes were pruned. `inlinedFrom` then names the wrapper.
   */
  functionName: string;
  /** Source file the attributed function was declared in. */
  file: string;
  /** Annotations parsed from the source function's leading comment block. */
  annotations: Annotations;
  /** Shapes dropped because they violated a `@firestore-mutex` group. */
  prunedByMutex: number;
  /** Shapes dropped because they were missing a `@firestore-required` field. */
  prunedByRequired: number;
  /** Warnings raised while parsing the source function's annotations. */
  warnings: AnnotationWarning[];
  /**
   * Set when the annotations originated on a wrapper that was inlined
   * into `functionName`. Names the wrapper so the agent can navigate to
   * the actual source of the annotation. Absent for caller-owned
   * annotations.
   */
  inlinedFrom?: string;
}

/** A single `where("field", "op", value)` constraint. */
export interface Filter {
  field: string;
  /** Operator string as it appears in source: "==", "<", ">=", "in", "array-contains", etc. */
  op: string;
}

/** A single `orderBy("field", "asc"|"desc")` constraint. */
export interface Order {
  field: string;
  direction: 'asc' | 'desc';
}

/**
 * One piece of a query chain produced by walking a function body.
 *
 * `kind: 'init'` describes the base — `query(collection(...))`. All other
 * kinds describe constraints layered on top.
 *
 * `branchId`/`clauseId`/`skippable` describe the if/else context where
 * the fragment was found. Two fragments under the same `branchId` but
 * different `clauseId` are mutually exclusive. `skippable: true` means
 * the if-chain has no `else`, so each clause is also "may not run at
 * all" when enumerating combinations.
 */
export interface Fragment {
  kind: 'init' | 'where' | 'orderBy' | 'limit' | 'unknown';
  collectionPath?: string | null;
  isCollectionGroup?: boolean;
  filter?: Filter;
  order?: Order;
  limit?: number;
  branchId: number | null;
  clauseId: number | null;
  skippable: boolean;
}

/**
 * A single function's extracted query state — base + fragments — before
 * branch enumeration. The orchestrator builds one of these per scanned
 * function body.
 */
export interface QueryBaseDecl {
  /** The local variable name the chain is built on (typically `q`). */
  varName: string;
  /** Last-segment-or-full literal collection path, or `null` if not statically resolvable. */
  collectionPath: string | null;
  /** True when the base was created via `collectionGroup(...)`. */
  isCollectionGroup: boolean;
  /** All fragments found in source order. */
  fragments: Fragment[];
  /**
   * Names of functions whose bodies were inlined into this decl by the
   * inter-procedural follower (Layer 2.5). Empty when no inlining
   * happened. The orchestrator uses this to (a) suppress the
   * `partial-base` warning for inlined wrappers and (b) attribute the
   * wrapper's annotations to the caller's `AnnotationApplied` entry.
   */
  inlinedFunctions?: string[];
  /**
   * Inter-procedural follower diagnostics surfaced from inside the
   * walker. The orchestrator promotes each into an `ExtractionWarning`.
   * Optional — absent when no inter-proc work happened.
   */
  interProcWarnings?: { code: 'inter-proc-nested' | 'inter-proc-recursion'; functionName: string; message: string }[];
}

/**
 * One enumerated query the source code may issue at runtime. Generated
 * by the cartesian product across `branchId`s in a `QueryBaseDecl`.
 */
export interface QueryShape {
  collectionPath: string;
  isCollectionGroup: boolean;
  filters: Filter[];
  orders: Order[];
  limit: number | null;
}

/**
 * One signal the extractor surfaces for a given collection — used by
 * the agent layer to decide whether to add `@firestore-mutex`
 * annotations. A high count of shapes for one collection is the
 * primary over-shoot signal.
 */
export interface ExtractionSignal {
  collectionGroup: string;
  /** How many shapes the extractor produced for this collection. */
  shapeCount: number;
  /**
   * Distinct fields that appeared in any filter/orderBy across those shapes.
   * If the count is high relative to typical query usage (≥ 4 fields), the
   * agent should consider whether some are mutually exclusive.
   */
  fieldsTouched: string[];
  /**
   * `true` if the extractor produced more shapes than would typically be
   * needed (heuristic: > 3 shapes for one collection). Hint for the
   * agent layer to suggest annotations.
   */
  overshootSuspected: boolean;
}

/** Per-file diagnostic surfaced when the extractor can't fully resolve a query. */
export interface ExtractionWarning {
  /** Source file the warning is about. */
  file: string;
  /**
   * - `'partial-base'` — the function body uses a `q` parameter; the
   *   INIT site lives in a caller (inter-procedural following NYI).
   * - `'unknown-callee'` — saw a call we don't recognize as
   *   query/where/orderBy/limit/collection/collectionGroup.
   * - `'dynamic-arg'` — a `where`/`orderBy` arg was non-literal.
   * - `'dynamic-direction'` — `orderBy` direction wasn't literally
   *   "asc"/"desc"; the extractor emitted both.
   */
  code:
    | 'partial-base'
    | 'unknown-callee'
    | 'dynamic-arg'
    | 'dynamic-direction'
    | 'parse-error'
    | 'budget-exceeded'
    | 'annotation-malformed'
    | 'inter-proc-nested'
    | 'inter-proc-recursion';
  message: string;
}

/**
 * Final extractor output. The `config` field is shaped exactly like
 * `firestore.indexes.json` so it can be passed directly to
 * `firestore_deploy_indexes`.
 */
export type ExtractResult =
  | {
      success: true;
      data: {
        config: IndexesConfig;
        signals: ExtractionSignal[];
        warnings: ExtractionWarning[];
        /** Total number of distinct query shapes the extractor enumerated. */
        shapesEnumerated: number;
        /**
         * One entry per function whose leading comment block carried any
         * `@firestore-*` activity (recognized tag or warning). Empty when
         * no annotations were used.
         */
        annotationsApplied: AnnotationApplied[];
      };
    }
  | {
      success: false;
      error: { code: 'PARSE_FAILED' | 'EXTRACT_FAILED'; message: string; recoverable: boolean };
    };

/** Options passed to the extractor. */
export interface ExtractOptions {
  /**
   * Bag of source files keyed by display name. The extractor processes
   * each independently; inter-procedural call following across files
   * is NYI (see I1 in the layer-1 progress doc).
   */
  files: { name: string; source: string }[];
  /**
   * Optional — the variable name typically used to chain queries.
   * Defaults to `'q'`. Most Firebase example code uses `q`; if a
   * codebase uses a different convention, override here.
   */
  queryVarName?: string;
}
