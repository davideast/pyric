/**
 * Types for static Firestore composite-index extraction.
 *
 * No logic in this file: these are the data contracts shared by
 * `composite.ts`, `extractor.ts`, `extractHandler.ts`, and
 * `firestoreIndexPass`.
 */

import type { IndexesConfig } from '../types.js';

export interface Annotations {
  mutexGroups: Set<string>[];
  required: Set<string>;
  budget?: number;
}

export type AnnotationWarningCode =
  | 'unknown-firestore-tag'
  | 'malformed-mutex'
  | 'malformed-required'
  | 'malformed-budget';

export interface AnnotationWarning {
  code: AnnotationWarningCode;
  tag: string;
  message: string;
}

export interface AnnotationApplied {
  functionName: string;
  file: string;
  annotations: Annotations;
  prunedByMutex: number;
  prunedByRequired: number;
  warnings: AnnotationWarning[];
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

/** Legacy query fragment shape retained for `pyric/rules/internal` type compatibility. */
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

/** Legacy function-level query declaration shape retained for `pyric/rules/internal` type compatibility. */
export interface QueryBaseDecl {
  varName: string;
  collectionPath: string | null;
  isCollectionGroup: boolean;
  fragments: Fragment[];
  inlinedFunctions?: string[];
  interProcWarnings?: {
    code: 'inter-proc-nested' | 'inter-proc-recursion';
    functionName: string;
    message: string;
  }[];
}

/** One enumerated query shape the source code may issue at runtime. */
export interface QueryShape {
  collectionPath: string;
  isCollectionGroup: boolean;
  filters: Filter[];
  orders: Order[];
  limit: number | null;
}

/** Per-collection summary of enumerated query shapes and fields touched. */
export interface ExtractionSignal {
  collectionGroup: string;
  shapeCount: number;
  fieldsTouched: string[];
  overshootSuspected: boolean;
}

/** Per-file diagnostic surfaced when a query or constraint cannot be statically resolved. */
export interface ExtractionWarning {
  file: string;
  line?: number;
  code:
    | 'unresolved-query'
    | 'partial-base'
    | 'dynamic-collection-id'
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

/** Final extractor output with `firestore.indexes.json` config, signals, and warnings. */
export type ExtractResult =
  | {
      success: true;
      data: {
        config: IndexesConfig;
        signals: ExtractionSignal[];
        warnings: ExtractionWarning[];
        shapesEnumerated: number;
        annotationsApplied: AnnotationApplied[];
      };
    }
  | {
      success: false;
      error: { code: 'PARSE_FAILED' | 'EXTRACT_FAILED'; message: string; recoverable: boolean };
    };

/** Options passed to `extractIndexes`. */
export interface ExtractOptions {
  /** Source files keyed by display name or relative module path. */
  files: { name: string; source: string; displayName?: string }[];
  /** Optional tsconfig JSON files keyed relative to `root`. */
  configs?: { name: string; source: string }[];
  /** Optional project root directory when scanning unified project files. */
  root?: string;
  /** Optional relative client roots restricting query ownership. */
  clientRoots?: string[];
}
