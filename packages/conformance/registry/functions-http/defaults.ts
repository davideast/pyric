import {
  type AuthoredRowRecord,
  type RowSection,
} from '../section-rows.ts';

export type FunctionsHttpEvidenceKind = 'observed' | 'upstream' | 'pyric';

/** Set only when the row's assertion set passes unweakened. */
export type FunctionsHttpFlip =
  | { status: 'conforms'; tests: string[] }
  | { status: 'unsupported'; reason: string; tests: string[] };

export interface FunctionsHttpRowSeed {
  order?: number;
  api: string;
  behavior: string;
  evidence: string;
  kind: FunctionsHttpEvidenceKind;
  observations?: string[];
  flip?: FunctionsHttpFlip;
  rowRef?: never;
  id?: never;
}

export const SUITE = 'packages/cli/test/functions-http/oracle-conformance.test.ts';
export const VITE_PLANE = 'packages/cli/test/functions-http/vite-plane.test.ts';

export const RISK_BY_KIND: Readonly<
  Record<
    FunctionsHttpEvidenceKind,
    { readonly risk: string; readonly riskScore: number; readonly reason: string }
  >
> = {
  observed: {
    risk: 'unobserved',
    riskScore: 2,
    reason:
      'Production behavior is not captured yet; the functions-http rig owns the observation.',
  },
  upstream: {
    risk: 'unobserved',
    riskScore: 1,
    reason:
      'Behavior stated from the firebase-functions 7.2.5 and firebase-tools 15.23.0 source; no production capture backs it.',
  },
  pyric: {
    risk: 'pyric-owned',
    riskScore: 1,
    reason:
      'Pyric-owned development behavior with no production counterpart; a unit or integration assertion backs it at flip.',
  },
};

export const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited, but pyric does not serve onRequest functions yet.';

interface ClimbRisk {
  risk: string[];
  riskScore: number;
  riskReasons: string[];
}

function buildUnflippedRisk(observed: boolean, kind: FunctionsHttpEvidenceKind): ClimbRisk {
  if (observed) {
    return {
      risk: ['cited-not-replayed'],
      riskScore: 1,
      riskReasons: [CITED_NOT_REPLAYED_REASON],
    };
  }
  const entry = RISK_BY_KIND[kind];
  return {
    risk: [entry.risk],
    riskScore: entry.riskScore,
    riskReasons: [entry.reason],
  };
}

export function bindFunctionsHttpRow(
  section: RowSection<{ readonly section: string; readonly featureKeys: string[] }>,
): (seed: FunctionsHttpRowSeed) => AuthoredRowRecord {
  return (seed: FunctionsHttpRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }
    const observations = seed.observations ?? [];
    const flip = seed.flip;

    return section.rowFromRef(seed.order, (rowRef) => {
      if (flip !== undefined) {
        const evidence = `${seed.evidence} Local assertion: \`${SUITE}\` assertion set \`functions-http#${rowRef}\`.`;
        const shared = {
          api: seed.api,
          behavior: seed.behavior,
          evidence,
          oracleObservations: observations,
          conformanceTests: flip.tests,
        };
        if (flip.status === 'unsupported') {
          return {
            ...shared,
            status: 'unsupported',
            automation: 'unsupported',
            exceptionReason: flip.reason,
          };
        }
        return {
          ...shared,
          status: 'conforms',
          automation: 'unit-backed',
          hostConformanceTests: flip.tests,
        };
      }
      const climbRisk = buildUnflippedRisk(observations.length > 0, seed.kind);
      return {
        api: seed.api,
        behavior: seed.behavior,
        evidence: seed.evidence,
        oracleObservations: observations,
        status: 'unverified',
        automation: 'unverified',
        ...climbRisk,
      };
    });
  };
}
