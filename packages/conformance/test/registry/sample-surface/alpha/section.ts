import { defineRowSection } from '../../../../registry/section-rows.ts';

export const section = defineRowSection({
  surface: 'ai',
  order: 10,
  defaults: {
    section: 'Sample section',
    status: 'conforms',
  },
  expandTest: (file) => `packages/pyric/test/ai/${file}`,
});

export const row = section.row;
