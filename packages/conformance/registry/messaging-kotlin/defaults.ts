import { MOCK_BRIDGE_STATUS_NOTE, resolveMockBridgeNote } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

export const CONFORMANCE_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/messaging/FirebaseMessagingTest.kt';

export const LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/native-kotlin-messaging-conformance.test.ts';

export interface KotlinMessagingRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  status?: CompatStatus;
  statusNote?: string;
  tests?: string[];
  hostConformanceTests?: string[];
  rowRef?: never;
  id?: never;
}

function resolveKotlinMessagingStatus(status: CompatStatus | undefined): CompatStatus {
  if (status !== undefined) {
    return status;
  }
  return 'unverified';
}

function resolveKotlinMessagingStatusNote(
  resolvedStatus: CompatStatus,
  rawStatus: CompatStatus | undefined,
  statusNote: string | undefined,
): string | undefined {
  if (resolvedStatus === 'unverified' && statusNote === undefined) {
    return MOCK_BRIDGE_STATUS_NOTE;
  }
  return resolveMockBridgeNote(rawStatus, statusNote);
}

function resolveKotlinMessagingTests(tests: readonly string[] | undefined): string[] {
  if (tests === undefined || tests.length === 0) {
    return [CONFORMANCE_SUITE];
  }
  return [...new Set(tests)];
}

function formatHostEvidence(hostTests: readonly string[] | undefined): string {
  if (hostTests === undefined || hostTests.length === 0) {
    return '';
  }
  return ` Live host: \`${hostTests.join('\`, \`')}\`.`;
}

export function bindKotlinMessagingRow(
  section: RowSection<{ readonly section: string }>,
): (seed: KotlinMessagingRowSeed) => AuthoredRowRecord {
  return (seed: KotlinMessagingRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, (rowRef) => {
      const resolvedStatus = resolveKotlinMessagingStatus(seed.status);
      const resolvedStatusNote = resolveKotlinMessagingStatusNote(
        resolvedStatus,
        seed.status,
        seed.statusNote,
      );
      const conformanceTests = resolveKotlinMessagingTests(seed.tests);
      let primarySuite = CONFORMANCE_SUITE;
      const firstSuite = conformanceTests[0];
      if (firstSuite !== undefined) {
        primarySuite = firstSuite;
      }
      let resolvedEvidence =
        `Kotlin suite: \`${primarySuite}\` assertion set \`messaging-kotlin#${rowRef}\`.`;
      if (seed.evidence !== undefined) {
        resolvedEvidence = seed.evidence;
      }
      const hostEvidence = formatHostEvidence(seed.hostConformanceTests);

      return {
        api: seed.api,
        behavior: seed.behavior,
        featureKeys: seed.featureKeys,
        status: resolvedStatus,
        statusNote: resolvedStatusNote,
        automation: 'unit-backed',
        conformanceTests,
        hostConformanceTests: seed.hostConformanceTests,
        risk: [],
        riskScore: 0,
        riskReasons: [],
        evidence: `${resolvedEvidence}${hostEvidence}`,
      };
    });
  };
}
