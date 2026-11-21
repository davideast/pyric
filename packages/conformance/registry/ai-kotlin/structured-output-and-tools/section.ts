import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-kotlin',
  order: 30,
  defaults: {
    section: 'Structured Output, Schema DSL & Function Calling',
  },
});

export const row = bindKotlinAiRow(section);
