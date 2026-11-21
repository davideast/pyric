import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-swift',
  order: 40,
  defaults: {
    section: 'Streaming Generation & Multi-Turn Chat',
  },
});

export const row = bindSwiftAiRow(section);
