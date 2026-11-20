import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 70,
  defaults: {
    section: '`UserPlatform` \u2014 profile & account mutations',
  },
});

export const row = bindFlutterAuthRow(section);
