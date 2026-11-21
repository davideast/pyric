import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-kotlin',
  order: 10,
  defaults: {
    section: 'Instance Scoping, Emulator & URL Routing',
  },
});

export const row = bindKotlinFunctionsRow(section);
