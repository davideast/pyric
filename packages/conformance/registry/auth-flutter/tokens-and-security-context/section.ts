import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 60,
  defaults: {
    section: '`UserPlatform` \u2014 tokens & security context',
  },
});

export const row = bindFlutterAuthRow(section);
