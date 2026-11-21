import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-kotlin',
  order: 40,
  defaults: {
    section: 'Streaming Generation & Multi-Turn Chat',
  },
});

export const row = bindKotlinAiRow(section);
