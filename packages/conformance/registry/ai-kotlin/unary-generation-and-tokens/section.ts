import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-kotlin',
  order: 20,
  defaults: {
    section: 'Unary Generation, Multimodal & Token Counting',
  },
});

export const row = bindKotlinAiRow(section);
