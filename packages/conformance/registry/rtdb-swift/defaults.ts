import { resolveMockBridgeNote } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

const CONFORMANCE_SUITE = 'packages/swift-client/Tests/PyricDatabaseTests/RtdbConformanceTests.swift';

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

function resolveRtdbTests(tests: readonly string[] | undefined): string[] {
  if (tests === undefined) {
    return [CONFORMANCE_SUITE];
  }
  return [CONFORMANCE_SUITE, ...tests];
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
    const resolvedTests = resolveRtdbTests(seed.tests);
    return section.rowFromRef(seed.order, (rowRef) => ({
      api: seed.api,
      behavior: seed.behavior,
      featureKeys: seed.featureKeys,
      status: resolvedStatus,
      statusNote: resolvedStatusNote,
      automation: 'unit-backed',
      evidence: `${resolvedEvidence} Swift test: \`${CONFORMANCE_SUITE}\` assertion set \`rtdb-swift#${rowRef}\`.`,
      conformanceTests: resolvedTests,
    }));
  };
}
