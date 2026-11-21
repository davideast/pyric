import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-flutter',
  order: 50,
  defaults: {
    section: 'Structured Errors, Timeouts & Cancellation',
  },
});

export const row = bindFlutterFunctionsRow(section);
