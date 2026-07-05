export type Surface = 'auth' | 'firestore' | 'rtdb' | 'rtdb-modular' | 'storage';

export type Automation =
  | 'oracle-backed'
  | 'unit-backed'
  | 'type-backed'
  | 'sandbox-only'
  | 'playground-only'
  | 'unsupported'
  | 'unverified';

export interface OracleConformanceCheck {
  finding: string;
  observation: string;
  expect: Record<string, unknown>;
  probe: string;
  guards: string;
}

export interface CompatibilityRow {
  id: string;
  surface: Surface;
  aliases: string[];
  rowRef: string;
  rowNumber: number | null;
  section: string;
  api: string;
  behavior: string;
  status: string;
  evidence: string;
  risk: string[];
  riskScore: number;
  riskReasons: string[];
  automation: Automation;
  oracleObservations: string[];
  conformanceTests: string[];
  exceptionReason?: string;
  notes?: string;
  conformanceChecks?: OracleConformanceCheck[];
}

export interface MarkdownBlock {
  kind: 'markdown';
  markdown: string;
}

export interface CompatibilityTableBlock {
  kind: 'table';
  prefix: string;
  rows: CompatibilityRow[];
}

export type CompatibilityDocBlock = MarkdownBlock | CompatibilityTableBlock;

export interface CompatibilitySurfaceRegistry {
  surface: Surface;
  compatPath: string;
  blocks: CompatibilityDocBlock[];
}
