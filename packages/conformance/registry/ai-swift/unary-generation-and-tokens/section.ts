import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-swift',
  order: 20,
  defaults: {
    section: 'Unary Generation, Multimodal & Token Counting',
  },
});

export const row = bindSwiftAiRow(section);
