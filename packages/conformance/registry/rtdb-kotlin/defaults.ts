import { resolveMockBridgeNote } from '../define-rows.ts';
import {
  type AuthoredRowRecord,
  type RowSection,
} from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

const CONFORMANCE_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/database/RtdbConformanceTest.kt';

const ORACLE_REPLAY_SUITE =
  'packages/conformance/test/src/rtdb-kotlin-oracle-replay.test.ts';

export const INFO_RECONNECT_TEST =
  'packages/kt-client/src/test/kotlin/dev/pyric/database/InfoConnectedReconnectTest.kt';

export const LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/native-kotlin-conformance.test.ts';

export interface KotlinRtdbRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  /** Tests beyond the conformance suite that also exercise this row. */
  tests?: string[];
  /** Live Pyric host end-to-end suites proving this row against a running host. */
  hostConformanceTests?: string[];
  /** Production Android SDK observation stems proving this row. */
  oracleObservations?: string[];
  /** Overrides the default mock-bridge `unverified` status. */
  status?: CompatStatus;
  statusNote?: string;
  rowRef?: never;
  id?: never;
}

export function bindKotlinRtdbRow(
  section: RowSection<{ readonly section: string }>,
): (seed: KotlinRtdbRowSeed) => AuthoredRowRecord {
  return (seed: KotlinRtdbRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, (rowRef) => {
      let resolvedEvidence = 'com.google.firebase:firebase-database specification.';
      if (seed.evidence !== undefined) {
        resolvedEvidence = seed.evidence;
      }
      let extraTests: string[] = [];
      if (seed.tests !== undefined) {
        extraTests = [...seed.tests];
      }
      let resolvedStatus: CompatStatus = 'unverified';
      if (seed.status !== undefined) {
        resolvedStatus = seed.status;
      }
      const hostTests = seed.hostConformanceTests;
      let hostEvidence = '';
      if (hostTests !== undefined && hostTests.length > 0) {
        hostEvidence = ` Live host: \`${hostTests.join('`, `')}\`.`;
      }

      const observations = seed.oracleObservations;
      if (observations !== undefined && observations.length > 0) {
        const obsTokens = observations.map((obs) => `\`${obs}.json\``).join(', ');
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: resolvedStatus,
          statusNote: resolveMockBridgeNote(seed.status, seed.statusNote),
          automation: 'oracle-backed',
          oracleObservations: [...observations],
          evidence: `${resolvedEvidence} Production capture: ${obsTokens} replayed in \`${ORACLE_REPLAY_SUITE}\`; unit suite: \`${CONFORMANCE_SUITE}\` assertion set \`rtdb-kotlin#${rowRef}\`.${hostEvidence}`,
          conformanceTests: [ORACLE_REPLAY_SUITE, CONFORMANCE_SUITE, ...extraTests],
          hostConformanceTests: hostTests,
        };
      }

      return {
        api: seed.api,
        behavior: seed.behavior,
        featureKeys: seed.featureKeys,
        status: resolvedStatus,
        statusNote: resolveMockBridgeNote(seed.status, seed.statusNote),
        automation: 'unit-backed',
        evidence: `${resolvedEvidence} Test: \`${CONFORMANCE_SUITE}\` assertion set \`rtdb-kotlin#${rowRef}\`.${hostEvidence}`,
        conformanceTests: [CONFORMANCE_SUITE, ...extraTests],
        hostConformanceTests: hostTests,
      };
    });
  };
}
