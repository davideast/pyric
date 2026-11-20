import { bindSwiftAuthRow } from '../defaults.ts';
import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'auth-swift',
  order: 70,
  defaults: {
    section: 'Multi-tenancy, Impersonation & Firestore Coupling',
  },
});

export const row = bindSwiftAuthRow(section);
