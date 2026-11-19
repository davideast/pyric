import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-admin',
  order: 240,
  prefix: '## `pyric-admin/auth`: Admin Auth user management and token verification\n\nThe admin Auth plane (surface `auth-admin`), mirroring `firebase-admin/auth` across in-process and remote worker sandboxes.\n',
  defaults: {
    section: 'firebase-admin `getAuth()` (`pyric-admin/auth`)',
  },
});

export const row = section.row;
