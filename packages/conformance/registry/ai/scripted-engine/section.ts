import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 110,
  defaults: {
    section: 'Sandbox answer engine: scripted',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
