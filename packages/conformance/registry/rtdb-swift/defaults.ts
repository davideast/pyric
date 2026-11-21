import { resolveMockBridgeNote } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

const CONFORMANCE_SUITE =
  'packages/swift-client/Tests/PyricDatabaseTests/RtdbConformanceTests.swift';

const WAVE2_ORACLE_REPLAY_SUITE =
  'packages/conformance/test/src/rtdb-swift-oracle-replay.test.ts';

const WAVE2_QUERIES_ORACLE_REPLAY_SUITE =
  'packages/conformance/test/src/rtdb-swift-wave2-queries-oracle-replay.test.ts';

const WAVE4_NAV_ORACLE_REPLAY_SUITE =
  'packages/conformance/test/src/rtdb-swift-wave4-nav-oracle-replay.test.ts';

const WAVE4_LIVE_ORACLE_REPLAY_SUITE =
  'packages/conformance/test/src/rtdb-swift-wave4-live-oracle-replay.test.ts';

export const LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/native-swift-conformance.test.ts';

export interface SwiftRtdbRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  /** Overrides the default mock-bridge `unverified` status. */
  status?: CompatStatus;
  statusNote?: string;
  /** Test files cited beyond the conformance suite. */
  tests?: string[];
  /** Live Pyric host end-to-end suites proving this row against a running host. */
  hostConformanceTests?: string[];
  /** Production Apple FirebaseDatabase observation stems proving this row. */
  oracleObservations?: string[];
  rowRef?: never;
  id?: never;
}

function resolveRtdbEvidence(evidence: string | undefined): string {
  if (evidence !== undefined) {
    return evidence;
  }
  return 'FirebaseDatabase Swift specification.';
}

function resolveRtdbStatus(status: CompatStatus | undefined): CompatStatus {
  if (status !== undefined) {
    return status;
  }
  return 'unverified';
}

function resolveExtraTests(tests: readonly string[] | undefined): string[] {
  if (tests === undefined) {
    return [];
  }
  return [...tests];
}

function formatHostEvidence(hostTests: readonly string[] | undefined): string {
  if (hostTests === undefined || hostTests.length === 0) {
    return '';
  }
  return ` Live host: \`${hostTests.join('`, `')}\`.`;
}

function replaySuiteForObservation(stem: string): string {
  if (stem === 'rtdb-swift-queries-ranges-limits-and-permission-denied') {
    return WAVE2_QUERIES_ORACLE_REPLAY_SUITE;
  }
  if (stem === 'rtdb-swift-navigation-push-priorities-and-snapshots') {
    return WAVE4_NAV_ORACLE_REPLAY_SUITE;
  }
  if (stem === 'rtdb-swift-listeners-transactions-connection-and-ondisconnect') {
    return WAVE4_LIVE_ORACLE_REPLAY_SUITE;
  }
  return WAVE2_ORACLE_REPLAY_SUITE;
}

function resolveReplaySuites(observations: readonly string[]): string[] {
  const suites: string[] = [];
  for (const stem of observations) {
    const suite = replaySuiteForObservation(stem);
    if (!suites.includes(suite)) {
      suites.push(suite);
    }
  }
  return suites;
}

export function bindSwiftRtdbRow(
  section: RowSection<{ readonly section: string }>,
): (seed: SwiftRtdbRowSeed) => AuthoredRowRecord {
  return (seed: SwiftRtdbRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }
    const resolvedEvidence = resolveRtdbEvidence(seed.evidence);
    const resolvedStatus = resolveRtdbStatus(seed.status);
    const resolvedStatusNote = resolveMockBridgeNote(seed.status, seed.statusNote);
    const extraTests = resolveExtraTests(seed.tests);
    const hostEvidence = formatHostEvidence(seed.hostConformanceTests);
    const observations = seed.oracleObservations;

    return section.rowFromRef(seed.order, (rowRef) => {
      if (observations !== undefined && observations.length > 0) {
        const replaySuites = resolveReplaySuites(observations);
        const obsTokens = observations.map((obs) => `\`${obs}.json\``).join(', ');
        const replayTokens = replaySuites.map((suite) => `\`${suite}\``).join(', ');
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: resolvedStatus,
          statusNote: resolvedStatusNote,
          automation: 'oracle-backed',
          oracleObservations: [...observations],
          evidence: `${resolvedEvidence} Production capture: ${obsTokens} replayed in ${replayTokens}; Swift test: \`${CONFORMANCE_SUITE}\` assertion set \`rtdb-swift#${rowRef}\`.${hostEvidence}`,
          conformanceTests: [...replaySuites, CONFORMANCE_SUITE, ...extraTests],
          hostConformanceTests: seed.hostConformanceTests,
        };
      }

      return {
        api: seed.api,
        behavior: seed.behavior,
        featureKeys: seed.featureKeys,
        status: resolvedStatus,
        statusNote: resolvedStatusNote,
        automation: 'unit-backed',
        evidence: `${resolvedEvidence} Swift test: \`${CONFORMANCE_SUITE}\` assertion set \`rtdb-swift#${rowRef}\`.${hostEvidence}`,
        conformanceTests: [CONFORMANCE_SUITE, ...extraTests],
        hostConformanceTests: seed.hostConformanceTests,
      };
    });
  };
}
