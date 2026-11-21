import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-flutter',
  order: 20,
  defaults: {
    section: 'Unary Generation, Multimodal & Token Counting',
  },
});

export const row = bindFlutterAiRow(section);
