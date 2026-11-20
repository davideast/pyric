import { resolveMockBridgeNote } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

const CONFORMANCE_SUITE = 'packages/flutter-client/test/rtdb_conformance_test.dart';

export const LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/native-flutter-conformance.test.ts';

export interface FlutterRtdbRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  status?: CompatStatus;
  statusNote?: string;
  tests?: string[];
  extraTests?: string[];
  /** Live Pyric host end-to-end suites proving this row against a running host. */
  hostConformanceTests?: string[];
  rowRef?: never;
  id?: never;
}

function formatHostEvidence(hostTests: readonly string[] | undefined): string {
  if (hostTests === undefined || hostTests.length === 0) {
    return '';
  }
  return ` Live host: \`${hostTests.join('`, `')}\`.`;
}

export function bindFlutterRtdbRow(
  section: RowSection<{ readonly section: string }>,
): (seed: FlutterRtdbRowSeed) => AuthoredRowRecord {
  return (seed: FlutterRtdbRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, () => {
      let resolvedEvidence =
        'Verified by packages/flutter-client/test/rtdb_conformance_test.dart.';
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
      if (seed.extraTests !== undefined) {
        for (const extraTest of seed.extraTests) {
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
