import { MOCK_BRIDGE_STATUS_NOTE } from '../define-rows.ts';
import {
  type AuthoredRowRecord,
  type RowSection,
} from '../section-rows.ts';

const CONFORMANCE_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/auth/ConformanceTest.kt';
const UNOBSERVED_REASON =
  'Behavior stated from com.google.firebase.auth specification; unit test has not passed yet.';

export interface KotlinAuthRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed';
  rowRef?: never;
  id?: never;
}

export function bindKotlinAuthRow(
  section: RowSection<{ readonly section: string }>,
): (seed: KotlinAuthRowSeed) => AuthoredRowRecord {
  return (seed: KotlinAuthRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, (rowRef) => {
      if (seed.flipped !== undefined) {
        const resolvedEvidence = seed.evidence ?? 'com.google.firebase.auth specification.';
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'unverified',
          statusNote: MOCK_BRIDGE_STATUS_NOTE,
          automation: 'unit-backed',
          evidence: `${resolvedEvidence} Test: \`${CONFORMANCE_SUITE}\` assertion set \`auth-kotlin#${rowRef}\`.`,
          conformanceTests: [CONFORMANCE_SUITE],
        };
      }
      const resolvedEvidence =
        seed.evidence ?? 'com.google.firebase.auth specification; unverified locally.';
      return {
        api: seed.api,
        behavior: seed.behavior,
        featureKeys: seed.featureKeys,
        status: 'unverified',
        automation: 'unverified',
        risk: ['unobserved'],
        riskScore: 2,
        riskReasons: [UNOBSERVED_REASON],
        evidence: resolvedEvidence,
      };
    });
  };
}
