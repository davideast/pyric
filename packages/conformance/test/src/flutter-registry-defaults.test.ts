import { describe, expect, it } from 'bun:test';
import { MOCK_BRIDGE_STATUS_NOTE } from '../../registry/define-rows.ts';
import {
  LIVE_HOST_CONFORMANCE_TEST as AUTH_LIVE_HOST_TEST,
  bindFlutterAuthRow,
} from '../../registry/auth-flutter/defaults.ts';
import {
  LIVE_HOST_CONFORMANCE_TEST as FIRESTORE_LIVE_HOST_TEST,
  bindFlutterFirestoreRow,
} from '../../registry/firestore-flutter/defaults.ts';
import {
  LIVE_HOST_CONFORMANCE_TEST as RTDB_LIVE_HOST_TEST,
  bindFlutterRtdbRow,
} from '../../registry/rtdb-flutter/defaults.ts';
import { defineRowSection } from '../../registry/section-rows.ts';
import { hasLiveHostConformanceEvidence } from '../../src/integration-host-evidence.ts';

const EXPECTED_FLUTTER_HOST_TEST =
  'packages/cli/test/serve/native-flutter-conformance.test.ts';

describe('Flutter registry defaults hostConformanceTests wiring', () => {
  it('exports the canonical live-host conformance test path across all three Flutter surfaces', () => {
    expect(AUTH_LIVE_HOST_TEST).toBe(EXPECTED_FLUTTER_HOST_TEST);
    expect(RTDB_LIVE_HOST_TEST).toBe(EXPECTED_FLUTTER_HOST_TEST);
    expect(FIRESTORE_LIVE_HOST_TEST).toBe(EXPECTED_FLUTTER_HOST_TEST);
  });

  it('keeps mock-bridge rows unverified without hostConformanceTests and promotes live-host rows cleanly', () => {
    const authSection = defineRowSection({
      surface: 'auth-flutter',
      order: 10,
      defaults: { section: 'Instance & Lifecycle' },
    });
    const rtdbSection = defineRowSection({
      surface: 'rtdb-flutter',
      order: 10,
      defaults: { section: 'Instance & Connection' },
    });
    const firestoreSection = defineRowSection({
      surface: 'firestore-flutter',
      order: 10,
      defaults: { section: 'Instance & Lifecycle' },
    });

    const authRow = bindFlutterAuthRow(authSection);
    const rtdbRow = bindFlutterRtdbRow(rtdbSection);
    const firestoreRow = bindFlutterFirestoreRow(firestoreSection);

    const authMock = authRow({
      api: 'FirebaseAuth.instance',
      behavior: 'Returns default auth instance',
      featureKeys: ['FirebaseAuth.instance'],
      flipped: 'unit-backed',
    }).build('1');
    expect(authMock.status).toBe('unverified');
    expect(authMock.statusNote).toBe(MOCK_BRIDGE_STATUS_NOTE);
    expect(authMock.hostConformanceTests).toBeUndefined();
    expect(hasLiveHostConformanceEvidence(authMock)).toBe(false);

    const authLive = authRow({
      api: 'FirebaseAuth.instance.signInAnonymously()',
      behavior: 'Signs in anonymously against live host',
      featureKeys: ['signInAnonymously'],
      status: 'conforms',
      tests: [AUTH_LIVE_HOST_TEST],
      hostConformanceTests: [AUTH_LIVE_HOST_TEST],
    }).build('2');
    expect(authLive.status).toBe('conforms');
    expect(authLive.statusNote).toBeUndefined();
    expect(authLive.conformanceTests).toEqual([
      'packages/flutter-client/test/auth/conformance_test.dart',
      EXPECTED_FLUTTER_HOST_TEST,
    ]);
    expect(authLive.hostConformanceTests).toEqual([EXPECTED_FLUTTER_HOST_TEST]);
    expect(authLive.evidence).toContain(`Live host: \`${EXPECTED_FLUTTER_HOST_TEST}\`.`);
    expect(hasLiveHostConformanceEvidence(authLive)).toBe(true);

    const rtdbMock = rtdbRow({
      api: 'FirebaseDatabase.instance',
      behavior: 'Returns default RTDB instance',
      featureKeys: ['FirebaseDatabase.instance'],
    }).build('instance-default');
    expect(rtdbMock.status).toBe('unverified');
    expect(rtdbMock.statusNote).toBe(MOCK_BRIDGE_STATUS_NOTE);
    expect(rtdbMock.hostConformanceTests).toBeUndefined();
    expect(hasLiveHostConformanceEvidence(rtdbMock)).toBe(false);

    const rtdbLive = rtdbRow({
      api: 'DatabaseReference.set(value)',
      behavior: 'Writes JSON value at path against live host',
      featureKeys: ['set'],
      status: 'conforms',
      tests: [RTDB_LIVE_HOST_TEST],
      hostConformanceTests: [RTDB_LIVE_HOST_TEST],
    }).build('write-set');
    expect(rtdbLive.status).toBe('conforms');
    expect(rtdbLive.statusNote).toBeUndefined();
    expect(rtdbLive.conformanceTests).toEqual([
      'packages/flutter-client/test/rtdb_conformance_test.dart',
      EXPECTED_FLUTTER_HOST_TEST,
    ]);
    expect(rtdbLive.hostConformanceTests).toEqual([EXPECTED_FLUTTER_HOST_TEST]);
    expect(rtdbLive.evidence).toContain(`Live host: \`${EXPECTED_FLUTTER_HOST_TEST}\`.`);
    expect(hasLiveHostConformanceEvidence(rtdbLive)).toBe(true);

    const firestoreMock = firestoreRow({
      api: 'FirebaseFirestore.instance',
      behavior: 'Returns default Firestore instance',
      featureKeys: ['FirebaseFirestore.instance'],
      flipped: 'unit-backed',
    }).build('1');
    expect(firestoreMock.status).toBe('unverified');
    expect(firestoreMock.statusNote).toBe(MOCK_BRIDGE_STATUS_NOTE);
    expect(firestoreMock.hostConformanceTests).toBeUndefined();
    expect(hasLiveHostConformanceEvidence(firestoreMock)).toBe(false);

    const firestoreLive = firestoreRow({
      api: 'DocumentReference.set(data)',
      behavior: 'Writes document against live host',
      featureKeys: ['DocumentReference.set'],
      status: 'conforms',
      tests: [FIRESTORE_LIVE_HOST_TEST],
      hostConformanceTests: [FIRESTORE_LIVE_HOST_TEST],
    }).build('10');
    expect(firestoreLive.status).toBe('conforms');
    expect(firestoreLive.statusNote).toBeUndefined();
    expect(firestoreLive.conformanceTests).toEqual([
      'packages/flutter-client/test/conformance_test.dart',
      EXPECTED_FLUTTER_HOST_TEST,
    ]);
    expect(firestoreLive.hostConformanceTests).toEqual([EXPECTED_FLUTTER_HOST_TEST]);
    expect(firestoreLive.evidence).toContain(`Live host: \`${EXPECTED_FLUTTER_HOST_TEST}\`.`);
    expect(hasLiveHostConformanceEvidence(firestoreLive)).toBe(true);
  });
});
