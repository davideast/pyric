import type { QueryProofResidual } from '../../rules/simulator/query-proof.js';

/** Local proof evidence. These categories do not claim a Firebase decision. */
export interface QueryProofFailure {
  kind: 'unsupported-predicate' | 'unsupported-path' | 'constraints-not-satisfied';
  reason: string;
  residual: QueryProofResidual;
  /** Location of the rejected predicate, which may be inside a helper. */
  predicate?: QueryProofFailure['rule'];
  rule?: {
    line?: number;
    col?: number;
    column?: number;
    file?: string;
    citation?: string;
    expression?: string;
  };
}

export interface QueryProofDiagnostic {
  kind: QueryProofFailure['kind'] | 'residual-denied' | 'no-rule';
  /** Rejected rules, in source order. None were evaluated against stored rows. */
  failures: QueryProofFailure[];
  /** Complete query identity, separate from the conservative proof projection. */
  query?: unknown;
}
