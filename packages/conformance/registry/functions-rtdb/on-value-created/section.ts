import { defineRowSection } from '../../section-rows.ts';
import { bindFunctionsRtdbRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-rtdb',
  order: 10,
  prefix: '## `onValueCreated` delivery and event contract\n',
  defaults: {
    section: '`firebase-functions/v2/database.onValueCreated`',
  },
});

export const row = bindFunctionsRtdbRow(section);
