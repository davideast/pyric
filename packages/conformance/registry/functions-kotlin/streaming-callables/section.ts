import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-kotlin',
  order: 40,
  defaults: {
    section: 'Server-Sent Events (SSE) Streaming',
  },
});

export const row = bindKotlinFunctionsRow(section);
