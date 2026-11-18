import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 30,
  defaults: {
    section: '`generateContentStream` framing and aggregation',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
