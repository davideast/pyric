import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-swift',
  order: 10,
  defaults: {
    section: 'Instance Scoping, Emulator & URL Routing',
  },
});

export const row = bindSwiftFunctionsRow(section);
