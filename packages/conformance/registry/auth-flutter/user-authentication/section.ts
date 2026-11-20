import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 20,
  defaults: {
    section: '`FirebaseAuthPlatform` \u2014 user authentication',
  },
});

export const row = bindFlutterAuthRow(section);
