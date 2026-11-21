import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-swift',
  order: 50,
  defaults: {
    section: 'Structured Errors, Timeouts & Cancellation',
  },
});

export const row = bindSwiftFunctionsRow(section);
