import { MOCK_BRIDGE_STATUS_NOTE } from '../define-rows.ts';
import {
  type AuthoredRowRecord,
  type RowSection,
} from '../section-rows.ts';

const CONFORMANCE_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/auth/ConformanceTest.kt';
const LIVE_HOST_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/e2e/AuthLiveHostConformanceTest.kt';
const LIVE_HOST_RUNNER =
  'packages/cli/test/serve/native-kotlin-conformance.test.ts';
const ORACLE_REPLAY_SUITE =
  'packages/conformance/test/src/auth-kotlin-oracle-replay.test.ts';
const UNOBSERVED_REASON =
  'Behavior stated from com.google.firebase.auth specification; unit test has not passed yet.';

export interface KotlinAuthRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed' | 'live-host' | 'oracle-backed';
  oracleObservations?: string[];
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
      if (seed.flipped === 'oracle-backed') {
        const observations = seed.oracleObservations;
        if (!observations || observations.length === 0) {
          throw new Error(
            `auth-kotlin#${rowRef}: flipped: 'oracle-backed' requires non-empty oracleObservations`,
          );
        }
        let oracleEvidence = 'com.google.firebase.auth Android SDK production capture.';
        if (seed.evidence !== undefined) {
          oracleEvidence = seed.evidence;
        }
        const obsTokens = observations.map((obs) => `\`${obs}.json\``).join(', ');
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'conforms',
          automation: 'oracle-backed',
          oracleObservations: [...observations],
          evidence: `${oracleEvidence} Production capture: ${obsTokens} replayed in \`${ORACLE_REPLAY_SUITE}\`; unit suite: \`${CONFORMANCE_SUITE}\` assertion set \`auth-kotlin#${rowRef}\`; live host: \`${LIVE_HOST_SUITE}\` via \`${LIVE_HOST_RUNNER}\`.`,
          conformanceTests: [
            ORACLE_REPLAY_SUITE,
            CONFORMANCE_SUITE,
            LIVE_HOST_SUITE,
            LIVE_HOST_RUNNER,
          ],
          hostConformanceTests: [LIVE_HOST_RUNNER],
        };
      }
      if (seed.flipped === 'live-host') {
        let liveEvidence = 'com.google.firebase.auth specification.';
        if (seed.evidence !== undefined) {
          liveEvidence = seed.evidence;
        }
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'conforms',
          automation: 'unit-backed',
          evidence: `${liveEvidence} Unit suite: \`${CONFORMANCE_SUITE}\` assertion set \`auth-kotlin#${rowRef}\`; live host: \`${LIVE_HOST_SUITE}\` via \`${LIVE_HOST_RUNNER}\`.`,
          conformanceTests: [CONFORMANCE_SUITE, LIVE_HOST_SUITE, LIVE_HOST_RUNNER],
          hostConformanceTests: [LIVE_HOST_RUNNER],
        };
      }
      if (seed.flipped === 'unit-backed') {
        let unitEvidence = 'com.google.firebase.auth specification.';
        if (seed.evidence !== undefined) {
          unitEvidence = seed.evidence;
        }
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'unverified',
          statusNote: MOCK_BRIDGE_STATUS_NOTE,
          automation: 'unit-backed',
          evidence: `${unitEvidence} Test: \`${CONFORMANCE_SUITE}\` assertion set \`auth-kotlin#${rowRef}\`.`,
          conformanceTests: [CONFORMANCE_SUITE],
        };
      }
      let unverifiedEvidence = 'com.google.firebase.auth specification; unverified locally.';
      if (seed.evidence !== undefined) {
        unverifiedEvidence = seed.evidence;
      }
      return {
        api: seed.api,
        behavior: seed.behavior,
        featureKeys: seed.featureKeys,
        status: 'unverified',
        automation: 'unverified',
        risk: ['unobserved'],
        riskScore: 2,
        riskReasons: [UNOBSERVED_REASON],
        evidence: unverifiedEvidence,
      };
    });
  };
}
