import { defineRowSection } from '../../section-rows.ts';
import { expandAiClimbTest } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 60,
  defaults: {
    section: '`countTokens`',
    status: 'conforms',
  },
  expandTest: expandAiClimbTest,
});

export const row = section.row;
