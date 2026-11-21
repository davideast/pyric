import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

export const CONFORMANCE_SUITE =
  'packages/pyric/test/crashlytics/crashlytics.test.ts';

export const LIVE_HOST_CONFORMANCE_TEST =
  'packages/cli/test/serve/crashlytics-bridge.test.ts';

export interface WebCrashlyticsRowSeed {
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

function resolveWebCrashlyticsStatus(status: CompatStatus | undefined): CompatStatus {
  if (status !== undefined) {
    return status;
  }
  return 'unverified';
}

function resolveWebCrashlyticsStatusNote(
  resolvedStatus: CompatStatus,
  _rawStatus: CompatStatus | undefined,
  statusNote: string | undefined,
): string | undefined {
  if (statusNote !== undefined) {
    return statusNote;
  }
  if (resolvedStatus === 'unverified') {
    return 'Verified in in-process unit suite; not yet exercised against a live HostedRuntime.';
  }
  return undefined;
}

function resolveWebCrashlyticsTests(tests: readonly string[] | undefined): string[] {
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

export function bindWebCrashlyticsRow(
  section: RowSection<{ readonly section: string }>,
): (seed: WebCrashlyticsRowSeed) => AuthoredRowRecord {
  return (seed: WebCrashlyticsRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, (rowRef) => {
      const resolvedStatus = resolveWebCrashlyticsStatus(seed.status);
      const resolvedStatusNote = resolveWebCrashlyticsStatusNote(
        resolvedStatus,
        seed.status,
        seed.statusNote,
      );
      const conformanceTests = resolveWebCrashlyticsTests(seed.tests);
      let primarySuite = CONFORMANCE_SUITE;
      const firstSuite = conformanceTests[0];
      if (firstSuite !== undefined) {
        primarySuite = firstSuite;
      }
      let resolvedEvidence =
        `Web suite: \`${primarySuite}\` assertion set \`crashlytics#${rowRef}\`.`;
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
