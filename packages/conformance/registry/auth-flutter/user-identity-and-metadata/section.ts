import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 50,
  defaults: {
    section: '`UserPlatform` \u2014 identity properties & metadata',
  },
});

export const row = bindFlutterAuthRow(section);
