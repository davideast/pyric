export type RuleScalar = string | number | boolean | null;

interface RuleCheckLocation {
  expression: string;
  parent: number | null;
  helper?: string;
  binding?: string;
}

export type RuleCheck = RuleCheckLocation & (
  | { state: 'value'; value: RuleScalar }
  | { state: 'error'; error: string }
  | { state: 'skipped' | 'unavailable' }
);

/** Bounded evidence from the evaluation that handled a request; never a replay. */
export interface RulesEvidence {
  version: string;
  scope: 'request' | 'query-residual';
  decision: 'ALLOW' | 'DENY' | 'UNSUPPORTED';
  truncated: boolean;
  rules: Array<{
    expression: string;
    verdict: 'ALLOW' | 'DENY' | 'ERROR' | 'UNSUPPORTED';
    line?: number;
    path?: string;
    error?: string;
    checks: RuleCheck[];
  }>;
  paths: Array<{ path: string; matched: boolean; line?: number }>;
  queryProof?: {
    kind: string;
    failures: Array<{ reason: string; expression?: string; line?: number }>;
  };
}
