import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-swift',
  order: 40,
  defaults: {
    section: 'Server-Sent Events (SSE) Streaming',
  },
});

export const row = bindSwiftFunctionsRow(section);
