import { resolveMockBridgeNote } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

export const CONFORMANCE_SUITE =
  'packages/flutter-client/test/storage/pyric_reference_platform_test.dart';

export const LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/native-flutter-storage-conformance.test.ts';

export interface FlutterStorageRowSeed {
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

function resolveFlutterStorageStatus(status: CompatStatus | undefined): CompatStatus {
  if (status !== undefined) {
    return status;
  }
  return 'unverified';
}

function resolveFlutterStorageTests(tests: readonly string[] | undefined): string[] {
  if (tests === undefined || tests.length === 0) {
    return [CONFORMANCE_SUITE];
  }
  return [...new Set(tests)];
}

function formatHostEvidence(hostTests: readonly string[] | undefined): string {
  if (hostTests === undefined || hostTests.length === 0) {
    return '';
  }
  return ` Live host: \`${hostTests.join('`, `')}\`.`;
}

export function bindFlutterStorageRow(
  section: RowSection<{ readonly section: string }>,
): (seed: FlutterStorageRowSeed) => AuthoredRowRecord {
  return (seed: FlutterStorageRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, (rowRef) => {
      const resolvedStatus = resolveFlutterStorageStatus(seed.status);
      const resolvedStatusNote = resolveMockBridgeNote(seed.status, seed.statusNote);
      const conformanceTests = resolveFlutterStorageTests(seed.tests);
      const primarySuite = conformanceTests[0] ?? CONFORMANCE_SUITE;
      let resolvedEvidence =
        `Flutter suite: \`${primarySuite}\` assertion set \`storage-flutter#${rowRef}\`.`;
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
