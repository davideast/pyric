import { resolveMockBridgeNote } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

const CONFORMANCE_SUITE =
  'packages/swift-client/Tests/PyricFirestoreTests/ConformanceCoreTests.swift';
const CONFORMANCE_QUERY_SUITE =
  'packages/swift-client/Tests/PyricFirestoreTests/ConformanceQueryAndCodableTests.swift';
const UNOBSERVED_REASON =
  'Behavior stated from FirebaseFirestore Swift specification; test has not passed yet.';

export const LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/native-swift-conformance.test.ts';
export const LIVE_HOST_LIFECYCLE_SUITE =
  'packages/swift-client/Tests/PyricLiveHostTests/FirestoreLifecycleLiveHostConformanceTests.swift';

export interface SwiftFirestoreRowSeed {
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

function suiteForRef(ref: number): string {
  if ((ref >= 1 && ref <= 40) || (ref >= 79 && ref <= 91)) {
    return CONFORMANCE_SUITE;
  }
  return CONFORMANCE_QUERY_SUITE;
}

export function bindSwiftFirestoreRow(
  section: RowSection<{ readonly section: string }>,
): (seed: SwiftFirestoreRowSeed) => AuthoredRowRecord {
  return (seed: SwiftFirestoreRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, (rowRef) => {
      const suite = suiteForRef(Number(rowRef));
      const unitBacked = seed.flipped !== undefined || seed.status !== undefined;
      if (unitBacked) {
        let resolvedEvidence = 'FirebaseFirestore Swift specification.';
        if (seed.evidence !== undefined) {
          resolvedEvidence = seed.evidence;
        }
        let resolvedStatus: CompatStatus = 'unverified';
        if (seed.status !== undefined) {
          resolvedStatus = seed.status;
        }
        const conformanceTests: string[] = [suite];
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
          evidence: `${resolvedEvidence} Swift test: \`${suite}\` assertion set \`firestore-swift#${rowRef}\`.${hostEvidence}`,
          conformanceTests,
          hostConformanceTests: seed.hostConformanceTests,
        };
      }
      let unverifiedEvidence = 'FirebaseFirestore Swift specification; unverified locally.';
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
