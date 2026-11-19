import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'app',
  order: 10,
  prefix: '## `initializeApp(config, name?)` — the app registry\n',
});

export const row = section.row;
