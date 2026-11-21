import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-swift',
  order: 20,
  defaults: {
    section: 'Callable Invocation & Wire Serialization',
  },
});

export const row = bindSwiftFunctionsRow(section);
