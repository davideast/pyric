import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-swift',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Backends',
  },
});

export const row = bindSwiftAiRow(section);
