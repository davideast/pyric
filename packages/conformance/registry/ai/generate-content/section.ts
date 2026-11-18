import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 20,
  defaults: {
    section: '`GenerativeModel.generateContent` envelope',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
