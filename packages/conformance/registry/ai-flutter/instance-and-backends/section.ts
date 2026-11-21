import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-flutter',
  order: 10,
  defaults: {
    section: 'Instance Scoping & Backends',
  },
});

export const row = bindFlutterAiRow(section);
