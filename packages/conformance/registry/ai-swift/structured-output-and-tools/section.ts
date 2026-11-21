import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-swift',
  order: 30,
  defaults: {
    section: 'Structured Output, Schema DSL & Function Calling',
  },
});

export const row = bindSwiftAiRow(section);
