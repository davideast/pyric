import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-kotlin',
  order: 30,
  defaults: {
    section: 'Auth & App Check Context Propagation',
  },
});

export const row = bindKotlinFunctionsRow(section);
