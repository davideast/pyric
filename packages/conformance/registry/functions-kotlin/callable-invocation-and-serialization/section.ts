import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-kotlin',
  order: 20,
  defaults: {
    section: 'Callable Invocation & Wire Serialization',
  },
});

export const row = bindKotlinFunctionsRow(section);
