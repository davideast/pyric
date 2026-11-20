import { MOCK_BRIDGE_STATUS_NOTE } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';

const CONFORMANCE_SUITE = 'packages/swift-client/Tests/PyricAuthTests/AuthConformanceTests.swift';
const UNOBSERVED_REASON =
  'Behavior stated from FirebaseAuth Swift specification; test has not passed yet.';

export interface SwiftAuthRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed';
  rowRef?: never;
  id?: never;
}

function resolveAuthEvidence(evidence: string | undefined, isFlipped: boolean): string {
  if (evidence !== undefined) {
    return evidence;
  }
  if (isFlipped) {
    return 'FirebaseAuth Swift specification.';
  }
  return 'FirebaseAuth Swift specification; unverified locally.';
}

export function bindSwiftAuthRow(
  section: RowSection<{ readonly section: string }>,
): (seed: SwiftAuthRowSeed) => AuthoredRowRecord {
  return (seed: SwiftAuthRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }
    const isFlipped = seed.flipped === 'unit-backed';
    const resolvedEvidence = resolveAuthEvidence(seed.evidence, isFlipped);
    return section.rowFromRef(seed.order, (rowRef) => {
      if (isFlipped) {
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'unverified',
          statusNote: MOCK_BRIDGE_STATUS_NOTE,
          automation: 'unit-backed',
          evidence: `${resolvedEvidence} Swift test: \`${CONFORMANCE_SUITE}\` assertion set \`auth-swift#${rowRef}\`.`,
          conformanceTests: [CONFORMANCE_SUITE],
        };
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
        evidence: resolvedEvidence,
      };
    });
  };
}
