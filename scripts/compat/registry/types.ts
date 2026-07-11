export type Surface =
  | 'auth'
  | 'firestore'
  | 'rtdb'
  | 'rtdb-modular'
  | 'storage'
  | 'messaging'
  | 'messaging-admin';

/**
 * Typed conformance status. Rendering (the ✓/⚠/✗/—/? glyphs in the
 * generated COMPAT.md docs) lives in scripts/compat/generate-docs.ts;
 * nothing should string-match glyphs to derive meaning.
 */
export type CompatStatus =
  | 'conforms'
  | 'diverged-documented'
  | 'bug'
  | 'unsupported'
  | 'unverified';

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
  status: CompatStatus;
  /** Display qualifier rendered after the status glyph, e.g. '(wrap)' or 'format'. */
  statusNote?: string;
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

/**
 * Everything a script needs to know about one compatibility surface.
 * Scripts iterate `surfaceDescriptors` (registry/index.ts) instead of
 * hardcoding surface lists; adding a surface is a data edit here plus a
 * registry file. Two descriptors may share one registry: `rtdb` and
 * `rtdb-modular` rows both live in the rtdb doc.
 */
export interface SurfaceDescriptor {
  surface: Surface;
  /** The doc registry hosting this surface's rows (and its compatPath). */
  registry: CompatibilitySurfaceRegistry;
  /** Observation filename prefix, e.g. 'rtdb-modular-'. Longest prefix wins. */
  observationPrefix: string;
  /** Repo-relative conformance suite path (future wiring; unset today). */
  conformanceSuite?: string;
  /**
   * A surface climbing under Conformance Driven Development (CDD): its rows are
   * authored born-`unverified` before implementation, and its generated doc
   * publishes at zero with a climb header. The climb lane and `compat:report`
   * select surfaces by this marker. Dropped at graduation. See
   * `docs/conformance/cdd.md`.
   */
  climb?: boolean;
}
