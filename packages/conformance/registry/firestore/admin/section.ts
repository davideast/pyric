import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore-admin',
  order: 300,
  prefix: '## `pyric-admin/firestore`: Admin Firestore chainable CRUD, queries, batches, and transactions\n\nThe admin Firestore plane (surface `firestore-admin`), mirroring `firebase-admin/firestore` across in-process and remote worker sandboxes.\n',
  defaults: {
    section: 'firebase-admin `getFirestore()` (`pyric-admin/firestore`)',
  },
});

export const row = section.row;
