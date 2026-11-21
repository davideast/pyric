import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-flutter',
  order: 30,
  defaults: {
    section: 'Auth & App Check Context Propagation',
  },
});

export const row = bindFlutterFunctionsRow(section);
