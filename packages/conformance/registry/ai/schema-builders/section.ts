import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 100,
  defaults: {
    section: '`Schema` builders',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
