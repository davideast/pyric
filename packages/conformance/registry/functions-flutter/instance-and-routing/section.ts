import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-flutter',
  order: 10,
  defaults: {
    section: 'Instance Scoping, Emulator & URL Routing',
  },
});

export const row = bindFlutterFunctionsRow(section);
