import { resolveMockBridgeNote } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

const CONFORMANCE_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/firestore/ConformanceTest.kt';
const UNOBSERVED_REASON =
  'Behavior stated from com.google.firebase.firestore specification; unit test has not passed yet.';

export const LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/native-kotlin-firestore-conformance.test.ts';
export const LIVE_HOST_CORE_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreCoreLiveHostConformanceTest.kt';
export const LIVE_HOST_SNAPSHOTS_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreSnapshotsLiveHostConformanceTest.kt';
export const LIVE_HOST_TRANSACTIONS_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/e2e/FirestoreTransactionsLiveHostConformanceTest.kt';

export interface KotlinFirestoreRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  tests?: string[];
  /** Live Pyric host end-to-end suites proving this row against a running host. */
  hostConformanceTests?: string[];
  flipped?: 'unit-backed';
  status?: CompatStatus;
  statusNote?: string;
  rowRef?: never;
  id?: never;
}

function formatHostEvidence(hostTests: readonly string[] | undefined): string {
  if (hostTests === undefined || hostTests.length === 0) {
    return '';
  }
  return ` Live host: \`${hostTests.join('`, `')}\`.`;
}

export function bindKotlinFirestoreRow(
  section: RowSection<{ readonly section: string }>,
): (seed: KotlinFirestoreRowSeed) => AuthoredRowRecord {
  return (seed: KotlinFirestoreRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, (rowRef) => {
      const unitBacked = seed.flipped !== undefined || seed.status !== undefined;
      if (unitBacked) {
        let resolvedEvidence = 'com.google.firebase.firestore specification.';
        if (seed.evidence !== undefined) {
          resolvedEvidence = seed.evidence;
        }
        let resolvedStatus: CompatStatus = 'unverified';
        if (seed.status !== undefined) {
          resolvedStatus = seed.status;
        }
        const conformanceTests: string[] = [CONFORMANCE_SUITE];
        if (seed.tests !== undefined) {
          for (const extraTest of seed.tests) {
            conformanceTests.push(extraTest);
          }
        }
        const hostEvidence = formatHostEvidence(seed.hostConformanceTests);
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: resolvedStatus,
          statusNote: resolveMockBridgeNote(seed.status, seed.statusNote),
          automation: 'unit-backed',
          evidence: `${resolvedEvidence} Test: \`${CONFORMANCE_SUITE}\` assertion set \`firestore-kotlin#${rowRef}\`.${hostEvidence}`,
          conformanceTests,
          hostConformanceTests: seed.hostConformanceTests,
        };
      }
      let unverifiedEvidence = 'com.google.firebase.firestore specification; unverified locally.';
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
