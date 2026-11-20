import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 10,
  defaults: {
    section: '`FirebaseAuthPlatform` \u2014 instance & lifecycle',
  },
});

export const row = bindFlutterAuthRow(section);
