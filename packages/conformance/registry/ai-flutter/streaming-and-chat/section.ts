import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-flutter',
  order: 40,
  defaults: {
    section: 'Streaming Generation & Multi-Turn Chat',
  },
});

export const row = bindFlutterAiRow(section);
