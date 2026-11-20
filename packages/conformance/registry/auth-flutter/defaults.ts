import { MOCK_BRIDGE_STATUS_NOTE } from '../define-rows.ts';
import type { AuthoredRowRecord, RowSection } from '../section-rows.ts';

const CONFORMANCE_SUITE = 'packages/flutter-client/test/auth/conformance_test.dart';
const UNOBSERVED_REASON =
  'Behavior stated from firebase_auth_platform_interface specification; containerized test has not passed yet.';

export interface FlutterAuthRowSeed {
  order?: number;
  api: string;
  behavior: string;
  featureKeys: string[];
  evidence?: string;
  flipped?: 'unit-backed';
  rowRef?: never;
  id?: never;
}

export function bindFlutterAuthRow(
  section: RowSection<{ readonly section: string }>,
): (seed: FlutterAuthRowSeed) => AuthoredRowRecord {
  return (seed: FlutterAuthRowSeed): AuthoredRowRecord => {
    const raw = seed as unknown as Record<string, unknown>;
    if ('rowRef' in raw && raw.rowRef !== undefined) {
      throw new Error("authored row record must not declare 'rowRef'; the filename is the rowRef");
    }
    if ('id' in raw && raw.id !== undefined) {
      throw new Error("authored row record must not declare 'id'; id is derived from surface and filename");
    }

    return section.rowFromRef(seed.order, (rowRef) => {
      if (seed.flipped !== undefined) {
        let resolvedEvidence = 'firebase_auth_platform_interface specification.';
        if (seed.evidence !== undefined) {
          resolvedEvidence = seed.evidence;
        }
        return {
          api: seed.api,
          behavior: seed.behavior,
          featureKeys: seed.featureKeys,
          status: 'unverified',
          statusNote: MOCK_BRIDGE_STATUS_NOTE,
          automation: 'unit-backed',
          evidence: `${resolvedEvidence} Container test: \`${CONFORMANCE_SUITE}\` assertion set \`auth-flutter#${rowRef}\`.`,
          conformanceTests: [CONFORMANCE_SUITE],
        };
      }
      let unverifiedEvidence =
        'firebase_auth_platform_interface specification; unverified locally.';
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
