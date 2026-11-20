import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAuthRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'auth-kotlin',
  order: 80,
  defaults: {
    section: "`CredentialsProvider` & Firestore Auth Coupling",
  },
});

export const row = bindKotlinAuthRow(section);
