import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-flutter',
  order: 40,
  defaults: {
    section: 'Multi-tenancy & AuthLens integration',
  },
});

export const row = bindFlutterAuthRow(section);
