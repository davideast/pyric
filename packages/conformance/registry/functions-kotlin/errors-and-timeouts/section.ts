import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-kotlin',
  order: 50,
  defaults: {
    section: 'Structured Errors, Timeouts & Cancellation',
  },
});

export const row = bindKotlinFunctionsRow(section);
