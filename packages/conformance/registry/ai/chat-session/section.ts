import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 40,
  defaults: {
    section: '`ChatSession` history and streaming turns',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
