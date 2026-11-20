import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 80,
  defaults: {
    section: '`UserCredentialPlatform` & supporting models',
  },
});

export const row = bindFlutterAuthRow(section);
