import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterFunctionsRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: 'functions-flutter',
  order: 20,
  defaults: {
    section: 'Callable Invocation & Wire Serialization',
  },
});

export const row = bindFlutterFunctionsRow(section);
