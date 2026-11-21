import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-swift',
  order: 50,
  defaults: {
    section: 'App Check Enforcement, Safety Blocks & Error Mapping',
  },
});

export const row = bindSwiftAiRow(section);
