import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 50,
  defaults: {
    section: 'Function calling',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
