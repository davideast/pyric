import { defineRowSection } from '../../section-rows.ts';
import { bindMessagingBehaviorRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'messaging',
  order: 30,
  defaults: {
    section: 'Behavior classes over time & across clients (client receive plane)',
  },
});

export const row = bindMessagingBehaviorRow(section);
