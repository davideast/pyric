import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterAiRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai-flutter',
  order: 50,
  defaults: {
    section: 'App Check Enforcement, Safety Blocks & Error Mapping',
  },
});

export const row = bindFlutterAiRow(section);
