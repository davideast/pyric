import { resolveMockBridgeNote } from '../define-rows.ts';
import {
  type AuthoredRowRecord,
  type RowSection,
} from '../section-rows.ts';
import type { CompatStatus } from '../types.ts';

const CONFORMANCE_SUITE =
  'packages/kt-client/src/test/kotlin/dev/pyric/database/RtdbConformanceTest.kt';

export const INFO_RECONNECT_TEST =
  'packages/kt-client/src/test/kotlin/dev/pyric/database/InfoConnectedReconnectTest.kt';

export interface KotlinRtdbRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  /** Tests beyond the conformance suite that also exercise this row. */
  tests?: string[];
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
      const resolvedEvidence =
        seed.evidence ?? 'com.google.firebase:firebase-database specification.';
      const extraTests = seed.tests ?? [];
      const resolvedStatus = seed.status ?? 'unverified';
      return {
        api: seed.api,
        behavior: seed.behavior,
        featureKeys: seed.featureKeys,
        status: resolvedStatus,
        statusNote: resolveMockBridgeNote(seed.status, seed.statusNote),
        automation: 'unit-backed',
        evidence: `${resolvedEvidence} Test: \`${CONFORMANCE_SUITE}\` assertion set \`rtdb-kotlin#${rowRef}\`.`,
        conformanceTests: [CONFORMANCE_SUITE, ...extraTests],
      };
    });
  };
}
