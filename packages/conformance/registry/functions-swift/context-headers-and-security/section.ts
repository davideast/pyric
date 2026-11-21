import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-swift',
  order: 30,
  defaults: {
    section: 'Auth & App Check Context Propagation',
  },
});

export const row = bindSwiftFunctionsRow(section);
