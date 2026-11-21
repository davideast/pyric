import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-swift",
  order: 20,
  defaults: {
    section: "Reference Navigation & URL Parsing",
  },
});

export const row = bindSwiftStorageRow(section);
