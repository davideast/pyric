import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 90,
  defaults: {
    section: 'Response helpers (`EnhancedGenerateContentResponse`)',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
