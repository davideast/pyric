import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-kotlin',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Backends',
  },
});

export const row = bindKotlinAiRow(section);
