import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 10,
  defaults: {
    section: '`getAI(target)` and dispatch',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
