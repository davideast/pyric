import {
  type AuthoredRowRecord,
  type FileRowSeed,
  type RowSection,
} from '../section-rows.ts';
import type {
  CompatibilityRow,
  ConformanceDisposition,
  OracleConformanceCheck,
} from '../types.ts';

export type AppCheckPlane = 'app-check' | 'app-check-admin';

export const APP_CHECK_SUITES: Record<AppCheckPlane, string> = {
  'app-check': 'packages/pyric/test/app-check/oracle-conformance.test.ts',
  'app-check-admin': 'packages/pyric-admin/test/app-check/oracle-conformance.test.ts',
};

export const UNOBSERVED_REASON =
  'Behavior stated from upstream documentation and typings only (firebase 12.13.0, firebase-admin 13); no committed capture vouches for it.';

export const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited, but not yet replayed against the sandbox; the citation does not lock the claim until the suite replays it.';

export const ERROR_TEXT_REASON =
  'asserts production error codes and message text that can drift on re-capture';

/** App scenario that drives the web SDK plane through a real dev server and Chromium. */
export const SANDBOX_SCENARIO = 'test/apps/sandbox-app-check/scenario.ts';

export interface AppCheckCddRowSeed {
  order?: number;
  section?: string;
  api: string;
  featureKeys: string[];
  behavior: string;
  evidence: string;
  observations?: string[];
  /** Asserts production error codes or message text. */
  errorText?: boolean;
  notes?: string;
  /** Set when the row's assertion set passes: the evidence tier it earned. */
  flipped?: 'oracle-backed' | 'unit-backed';
  /** Additional test witnesses beyond the surface's default conformance suite. */
  extraTests?: string[];
  /** Structured observation-to-probe conformance checks executed by compat:oracle-check. */
  conformanceChecks?: OracleConformanceCheck[];
  /** Set when the sandbox deliberately or knowingly differs (cdd.md Step 6). */
  diverged?: ConformanceDisposition;
  /** Set when the sandbox will never model the behavior. */
  unsupportedReason?: string;
  rowRef?: never;
  id?: never;
}

function riskFor(seed: AppCheckCddRowSeed): Pick<CompatibilityRow, 'risk' | 'riskScore' | 'riskReasons'> {
  const observations = seed.observations ?? [];
  const observed = observations.length > 0;
  let risk: string[];
  let riskScore: number;
  let riskReasons: string[];
  if (observed) {
    risk = ['cited-not-replayed'];
    riskScore = 1;
    riskReasons = [CITED_NOT_REPLAYED_REASON];
  } else {
    risk = ['unobserved'];
    riskScore = 2;
    riskReasons = [UNOBSERVED_REASON];
  }
  if (seed.errorText) {
    risk.push('error-code');
    riskReasons.push(ERROR_TEXT_REASON);
  }
  return { risk, riskScore, riskReasons };
}

function witnesses(plane: AppCheckPlane, extraTests: readonly string[] | undefined): string[] {
  let base: string[];
  if (plane === 'app-check') {
    base = [APP_CHECK_SUITES[plane], SANDBOX_SCENARIO];
  } else {
    base = [APP_CHECK_SUITES[plane]];
  }
  if (!extraTests) {
    return base;
  }
  return [...base, ...extraTests];
}

function tierFor(plane: AppCheckPlane, seed: AppCheckCddRowSeed): Partial<CompatibilityRow> {
  const suite = witnesses(plane, seed.extraTests);
  if (seed.unsupportedReason) {
    return {
      status: 'unsupported',
      automation: 'unsupported',
      exceptionReason: seed.unsupportedReason,
      risk: ['unsupported'],
      riskScore: 0,
      riskReasons: [seed.unsupportedReason],
    };
  }
  if (seed.diverged) {
    return {
      status: 'diverged-documented',
      automation: 'oracle-backed',
      conformanceDisposition: seed.diverged,
      conformanceTests: suite,
    };
  }
  if (seed.flipped === 'oracle-backed') {
    return {
      status: 'conforms',
      automation: 'oracle-backed',
      conformanceTests: suite,
      risk: [],
      riskScore: 0,
      riskReasons: [],
    };
  }
  if (seed.flipped === 'unit-backed') {
    return {
      status: 'conforms',
      automation: 'unit-backed',
      conformanceTests: suite,
      ...riskFor(seed),
    };
  }
  return {
    status: 'unverified',
    automation: 'unverified',
    ...riskFor(seed),
  };
}

export function bindAppCheckCddRow(
  plane: AppCheckPlane,
  section: RowSection<{ readonly section: string }>,
): (seed: AppCheckCddRowSeed) => AuthoredRowRecord {
  return (seed: AppCheckCddRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }
    const observations = seed.observations ?? [];
    const base: Omit<FileRowSeed<{ readonly section: string }>, 'status' | 'automation'> = {
      order: seed.order,
      section: seed.section,
      api: seed.api,
      featureKeys: seed.featureKeys,
      behavior: seed.behavior,
      evidence: seed.evidence,
      notes: seed.notes,
      conformanceChecks: seed.conformanceChecks,
      oracleObservations: observations,
    };
    return section.row({
      ...base,
      ...riskFor(seed),
      ...tierFor(plane, seed),
    } as FileRowSeed<{ readonly section: string }>);
  };
}
