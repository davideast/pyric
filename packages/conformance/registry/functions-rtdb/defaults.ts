import {
  type AuthoredRowRecord,
  type RowSection,
} from '../section-rows.ts';

export const CONFORMANCE_SUITE =
  'packages/cli/test/functions-rtdb/oracle-conformance.test.ts';

export const UNOBSERVED_REASON =
  'Behavior stated from the firebase-functions 7.2.5 public contract; production capture has not landed yet.';

export const CITED_NOT_REPLAYED_REASON =
  'Production observed and cited, but Pyric has no local Functions runtime to replay it yet.';

export interface FunctionsRtdbRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence: string;
  observations?: string[];
  /** Set only when the unchanged local replay passes for this row. */
  flipped?: 'oracle-backed';
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

export function bindFunctionsRtdbRow(
  section: RowSection<{ readonly section: string }>,
): (seed: FunctionsRtdbRowSeed) => AuthoredRowRecord {
  return (seed: FunctionsRtdbRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }
    const observations = seed.observations ?? [];

    return section.rowFromRef(seed.order, (rowRef) => {
      if (seed.flipped !== undefined) {
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          oracleObservations: observations,
          status: 'conforms',
          automation: seed.flipped,
          evidence: `${seed.evidence} Local replay: \`${CONFORMANCE_SUITE}\` assertion set \`functions-rtdb#${rowRef}\`.`,
          conformanceTests: [CONFORMANCE_SUITE],
          hostConformanceTests: [CONFORMANCE_SUITE],
        };
      }
      const climbRisk = buildClimbRisk(observations.length > 0);
      return {
        api: seed.api,
        behavior: seed.behavior,
        featureKeys: seed.featureKeys,
        evidence: seed.evidence,
        oracleObservations: observations,
        status: 'unverified',
        automation: 'unverified',
        ...climbRisk,
      };
    });
  };
}
