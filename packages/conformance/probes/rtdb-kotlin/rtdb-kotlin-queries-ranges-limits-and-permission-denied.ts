import type { Probe } from '../../rigs/types.ts';
import {
  buildAndroidRtdbPermissionAndQueryRules,
  runAndroidRobolectricProbe,
} from '../../src/android-oracle-runtime.ts';

export const probe: Probe = {
  description:
    'Upstream Android FirebaseDatabase orderByKey, orderByValue, and orderByChild queries with startAt/endAt ranges, 1-arg and 2-arg equalTo filters, limitToFirst/limitToLast bounds, and DatabaseError.PERMISSION_DENIED on denied read/write paths under Robolectric.',
  matrixRow: 'rtdb-kotlin#query-order-by-key',
  rowIds: [
    'rtdb-kotlin#query-order-by-key',
    'rtdb-kotlin#query-order-by-value',
    'rtdb-kotlin#query-equal-to',
    'rtdb-kotlin#query-range',
    'rtdb-kotlin#query-limit',
  ],
  rig: 'android-sdk-probes',
  requires: ['web-config', 'dedicated-rtdb', 'admin-auth'],
  async observe(): Promise<Record<string, unknown>> {
    return runAndroidRobolectricProbe({
      probeId: 'rtdb-kotlin-queries-ranges-limits-and-permission-denied',
      needsDedicatedRtdb: true,
      rtdbRunRules: buildAndroidRtdbPermissionAndQueryRules(),
    });
  },
};
