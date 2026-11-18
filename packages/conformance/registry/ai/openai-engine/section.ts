import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 120,
  defaults: {
    section: 'Sandbox answer engine: openai translation',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
