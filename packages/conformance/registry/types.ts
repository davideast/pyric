export type Surface =
  | 'app'
  | 'ai'
  | 'auth'
  | 'firestore'
  | 'rtdb'
  | 'rtdb-modular'
  | 'storage'
  | 'messaging'
  | 'messaging-admin'
  // Native surfaces (no upstream module to mirror; conformance is measured
  // against their own public API and the production Rules Test API engine).
  // `firestore-rules` and `storage-rules` are descriptor surfaces; `rules` is
  // the shared registry key both resolve to (the one COMPAT doc they share),
  // on the `rtdb`/`rtdb-modular` -> `rtdb` registry precedent.
  | 'firestore-rules'
  | 'storage-rules'
  | 'rtdb-rules'
  | 'rules';

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
  | 'shape-backed'
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
  /**
   * For rules-engine rows (`firestore-rules` / `storage-rules`): the
   * rules-language construct ids (`rules-language/<engine>.json`) whose behavior
   * this row adjudicates — the row's SCOPE in the language.
   *
   * Required on every rules-engine row whose status is `diverged-documented` or
   * `bug`, because that scope is what a divergence CONTAMINATES: the assurance
   * capability derivation (`src/assurance-capabilities.ts`) downgrades any
   * capability that depends on a construct listed here, so a known-wrong
   * simulator cannot silently underwrite a security claim. A divergence with no
   * declared scope would contaminate nothing, which is the failure mode this
   * field exists to prevent.
   *
   * Optional (and unused by the derivation) on conforming rows.
   */
  constructs?: string[];
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

// The surface descriptor (everything a script needs to know about one
// compatibility surface) now lives per-file in `surfaces/` — see
// `surfaces/types.ts` for the `SurfaceDescriptorRecord`/`SurfaceDescriptor`
// shapes and `surfaces/load.ts` for the loader.
