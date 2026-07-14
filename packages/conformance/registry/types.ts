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
  | 'functions-rtdb'
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
 * generated COMPAT.md docs) lives in packages/conformance/src/generate-docs.ts;
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
   * For rules-engine rows (`firestore-rules` / `storage-rules` / `rtdb-rules`):
   * the rules-language construct ids (`rules-language/<engine>.json`) whose
   * behavior this row's CAPTURED VERDICTS adjudicate — the row's SCOPE in the
   * language. Not everything the ruleset happens to touch: only what the
   * verdicts decide.
   *
   * The scope is read in both directions (`src/production-verification.ts`):
   *
   *   `diverged-documented` / `bug` — the scope is what the divergence
   *   CONTAMINATES: the assurance capability derivation downgrades any
   *   capability depending on a construct listed here, so a known-wrong
   *   simulator cannot silently underwrite a security claim. REQUIRED on such a
   *   row: a divergence with no declared scope would contaminate nothing, which
   *   is the failure mode this field exists to prevent.
   *
   *   `conforms` + `oracle-backed` — the scope is what the row PROVES: the
   *   BEHAVIORAL production-verification path. It credits a construct that no
   *   ruleset source can express, so the syntactic analyzer has no node to
   *   detect (the RTDB cascade semantics — what the engine does with a tree of
   *   rules). Optional, and an omission only under-credits.
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
