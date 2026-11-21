import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-kotlin',
  order: 50,
  defaults: {
    section: 'App Check Enforcement, Safety Blocks & Error Mapping',
  },
});

export const row = bindKotlinAiRow(section);
