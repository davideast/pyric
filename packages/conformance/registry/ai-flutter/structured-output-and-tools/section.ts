import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-flutter',
  order: 30,
  defaults: {
    section: 'Structured Output, Schema DSL & Function Calling',
  },
});

export const row = bindFlutterAiRow(section);
