import {
  type AuthoredRowRecord,
  type FileRowSeed,
  type RowSection,
} from '../section-rows.ts';

export type MessagingSurfacePlane = 'messaging' | 'messaging-admin';

export const SUITE: Readonly<Record<MessagingSurfacePlane, string>> = {
  messaging: 'packages/pyric/test/messaging/oracle-conformance.test.ts',
  'messaging-admin': 'packages/pyric-admin/test/messaging/oracle-conformance.test.ts',
};

export const UNOBSERVED_REASON =
  'Behavior stated from upstream typings/JSDoc only (firebase 12.13.0 / firebase-admin 13.10.0); no committed observation yet - a probe candidate before implementation.';

export const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited (see evidence), but not yet replayed offline against a sandbox; the citation does not lock the claim until the conformance suite replays it.';

export interface MessagingCddRowSeed {
  order?: number;
  section?: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence: string;
  /** Committed `messaging-*` observations that vouch for `behavior`. */
  observations?: string[];
  /** Additional blocking witnesses outside the in-process surface suite. */
  tests?: string[];
  notes?: string;
  /**
   * CDD flip (Step 4): set at review time when the row's assertion set in the
   * conformance suite passes unweakened. Absent = still climbing (born unverified).
   */
  flipped?: 'oracle-backed' | 'unit-backed' | 'type-backed';
  /** Why a `type-backed` or browser-bound `unit-backed` row has no headless runtime capture. */
  exceptionReason?: string;
  rowRef?: never;
  id?: never;
}

export interface MessagingBehaviorRowSeed {
  order?: number;
  section?: string;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence: string;
  /** Names what is unevidenced; required non-empty on unverified behavior-class rows. */
  riskReasons?: string[];
  observations?: string[];
  tests?: string[];
  flipped?: 'oracle-backed';
  notes?: string;
  /**
   * Set for a class the sandbox will never model. Becomes the row's
   * `exceptionReason` and flips it from born-unverified to `unsupported`.
   */
  unsupportedReason?: string;
  rowRef?: never;
  id?: never;
}

interface ClimbRisk {
  risk: string[];
  riskScore: number;
  riskReasons: string[];
}

function buildClimbRisk(observed: boolean): ClimbRisk {
  if (observed) {
    return {
      risk: ['cited-not-replayed'],
      riskScore: 1,
      riskReasons: [CITED_NOT_REPLAYED_REASON],
    };
  }
  return {
    risk: ['unobserved'],
    riskScore: 2,
    riskReasons: [UNOBSERVED_REASON],
  };
}

export function bindMessagingCddRow(
  surface: MessagingSurfacePlane,
  section: RowSection<{ readonly section: string }>,
): (seed: MessagingCddRowSeed) => AuthoredRowRecord {
  return (seed: MessagingCddRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }
    const observations = seed.observations ?? [];
    const tests = seed.tests ?? [];
    const climbRisk = buildClimbRisk(observations.length > 0);
    const base: Omit<FileRowSeed<{ readonly section: string }>, 'status' | 'automation'> = {
      order: seed.order,
      section: seed.section,
      api: seed.api,
      behavior: seed.behavior,
      featureKeys: seed.featureKeys,
      evidence: seed.evidence,
      notes: seed.notes,
      oracleObservations: observations,
      exceptionReason: seed.exceptionReason,
    };

    if (seed.flipped === undefined) {
      return section.row({
        ...base,
        status: 'unverified',
        automation: 'unverified',
        ...climbRisk,
      });
    }
    if (seed.flipped === 'oracle-backed') {
      return section.row({
        ...base,
        status: 'conforms',
        automation: 'oracle-backed',
        conformanceTests: [SUITE[surface], ...tests],
      });
    }
    if (seed.flipped === 'unit-backed') {
      return section.row({
        ...base,
        status: 'conforms',
        automation: 'unit-backed',
        conformanceTests: [SUITE[surface], ...tests],
        ...climbRisk,
      });
    }
    return section.row({
      ...base,
      status: 'conforms',
      automation: 'type-backed',
      exceptionReason: seed.exceptionReason,
      ...climbRisk,
    });
  };
}

export function bindMessagingBehaviorRow(
  section: RowSection<{ readonly section: string }>,
): (seed: MessagingBehaviorRowSeed) => AuthoredRowRecord {
  return (seed: MessagingBehaviorRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }
    const observations = seed.observations ?? [];
    const tests = seed.tests ?? [];
    const base: Omit<FileRowSeed<{ readonly section: string }>, 'status' | 'automation'> = {
      order: seed.order,
      section: seed.section,
      api: seed.api,
      behavior: seed.behavior,
      featureKeys: seed.featureKeys,
      evidence: seed.evidence,
      notes: seed.notes,
      oracleObservations: observations,
      riskReasons: seed.riskReasons ?? [],
    };
    if (seed.unsupportedReason) {
      return section.row({
        ...base,
        status: 'unsupported',
        automation: 'unsupported',
        exceptionReason: seed.unsupportedReason,
        risk: ['unsupported'],
        riskScore: 0,
      });
    }
    if (seed.flipped === 'oracle-backed') {
      return section.row({
        ...base,
        status: 'conforms',
        automation: 'oracle-backed',
        conformanceTests: [SUITE.messaging, ...tests],
      });
    }
    return section.row({
      ...base,
      status: 'unverified',
      automation: 'unverified',
      risk: ['unobserved'],
      riskScore: 2,
    });
  };
}
