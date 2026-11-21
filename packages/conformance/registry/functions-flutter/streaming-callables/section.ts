import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-flutter',
  order: 40,
  defaults: {
    section: 'Server-Sent Events (SSE) Streaming',
  },
});

export const row = bindFlutterFunctionsRow(section);
