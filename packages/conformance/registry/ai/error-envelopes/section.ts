import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 70,
  defaults: {
    section: 'Error envelopes',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
