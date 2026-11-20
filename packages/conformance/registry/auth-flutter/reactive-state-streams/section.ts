import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 30,
  defaults: {
    section: '`FirebaseAuthPlatform` \u2014 reactive state streams',
  },
});

export const row = bindFlutterAuthRow(section);
