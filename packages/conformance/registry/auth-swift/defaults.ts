import { MOCK_BRIDGE_STATUS_NOTE } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';

const CONFORMANCE_SUITE =
  'packages/swift-client/Tests/PyricAuthTests/AuthConformanceTests.swift';
const LIVE_HOST_SUITE =
  'packages/swift-client/Tests/PyricLiveHostTests/AuthLiveHostConformanceTests.swift';
const LIVE_HOST_RUNNER =
  'packages/cli/test/serve/native-swift-conformance.test.ts';
const ORACLE_REPLAY_SUITE =
  'packages/conformance/test/src/auth-swift-oracle-replay.test.ts';
const WAVE4_ORACLE_REPLAY_SUITE =
  'packages/conformance/test/src/auth-swift-wave4-oracle-replay.test.ts';
const WAVE4_OBSERVATION_STEM =
  'auth-swift-instance-linking-reauth-and-oauth-credentials';
const UNOBSERVED_REASON =
  'Behavior stated from FirebaseAuth Swift specification; test has not passed yet.';

export interface SwiftAuthRowSeed {
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

function resolveAuthEvidence(evidence: string | undefined, isVerified: boolean): string {
  if (evidence !== undefined) {
    return evidence;
  }
  if (isVerified) {
    return 'FirebaseAuth Swift specification.';
  }
  return 'FirebaseAuth Swift specification; unverified locally.';
}

export function bindSwiftAuthRow(
  section: RowSection<{ readonly section: string }>,
): (seed: SwiftAuthRowSeed) => AuthoredRowRecord {
  return (seed: SwiftAuthRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }
    const isOracleBacked = seed.flipped === 'oracle-backed';
    const isLiveHost = seed.flipped === 'live-host';
    const isUnitBacked = seed.flipped === 'unit-backed';
    const resolvedEvidence = resolveAuthEvidence(
      seed.evidence,
      isOracleBacked || isLiveHost || isUnitBacked,
    );
    return section.rowFromRef(seed.order, (rowRef) => {
      if (isOracleBacked) {
        const observations = seed.oracleObservations;
        if (observations === undefined || observations.length === 0) {
          throw new Error(
            `auth-swift#${rowRef}: oracle-backed row must declare non-empty oracleObservations`,
          );
        }
        const hasWave4 = observations.includes(WAVE4_OBSERVATION_STEM);
        const hasWave2 = observations.some((obs) => obs !== WAVE4_OBSERVATION_STEM);
        const replaySuites: string[] = [];
        if (hasWave2) {
          replaySuites.push(ORACLE_REPLAY_SUITE);
        }
        if (hasWave4) {
          replaySuites.push(WAVE4_ORACLE_REPLAY_SUITE);
        }
        const obsTokens = observations.map((obs) => `\`${obs}.json\``).join(', ');
        const replayTokens = replaySuites.map((suite) => `\`${suite}\``).join(', ');
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'conforms',
          automation: 'oracle-backed',
          oracleObservations: [...observations],
          evidence: `${resolvedEvidence} Production capture: ${obsTokens} replayed in ${replayTokens}; Swift unit suite: \`${CONFORMANCE_SUITE}\` assertion set \`auth-swift#${rowRef}\`; live host: \`${LIVE_HOST_SUITE}\` via \`${LIVE_HOST_RUNNER}\`.`,
          conformanceTests: [
            ...replaySuites,
            CONFORMANCE_SUITE,
            LIVE_HOST_SUITE,
            LIVE_HOST_RUNNER,
          ],
          hostConformanceTests: [LIVE_HOST_RUNNER],
        };
      }
      if (isLiveHost) {
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'conforms',
          automation: 'unit-backed',
          evidence: `${resolvedEvidence} Swift unit suite: \`${CONFORMANCE_SUITE}\` assertion set \`auth-swift#${rowRef}\`; live host: \`${LIVE_HOST_SUITE}\` via \`${LIVE_HOST_RUNNER}\`.`,
          conformanceTests: [CONFORMANCE_SUITE, LIVE_HOST_SUITE, LIVE_HOST_RUNNER],
          hostConformanceTests: [LIVE_HOST_RUNNER],
        };
      }
      if (isUnitBacked) {
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'unverified',
          statusNote: MOCK_BRIDGE_STATUS_NOTE,
          automation: 'unit-backed',
          evidence: `${resolvedEvidence} Swift test: \`${CONFORMANCE_SUITE}\` assertion set \`auth-swift#${rowRef}\`.`,
          conformanceTests: [CONFORMANCE_SUITE],
        };
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
        evidence: resolvedEvidence,
      };
    });
  };
}
