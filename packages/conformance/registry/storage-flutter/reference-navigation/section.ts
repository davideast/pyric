import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-flutter",
  order: 20,
  defaults: {
    section: "Reference Navigation & URL Parsing",
  },
});

export const row = bindFlutterStorageRow(section);
