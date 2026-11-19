import { defineRowSection } from '../../section-rows.ts';

export const adminCaptureTests = [
  'packages/pyric-admin/test/database/capture-admin-database-and-priorities.test.ts',
  'packages/cli/test/serve/worker/oracle-captures/rtdb-admin-database-and-priorities.test.ts',
];

export const section = defineRowSection({
  surface: 'rtdb-admin',
  order: 280,
  prefix: '## `pyric-admin/database`: Admin Realtime Database references, queries, listeners, and OnDisconnect\n\nThe admin Realtime Database plane (surface `rtdb-admin`), mirroring `firebase-admin/database` across in-process and remote worker sandboxes.\n',
  defaults: {
    section: 'firebase-admin `getDatabase()` (`pyric-admin/database`)',
  },
});

export const row = section.row;
