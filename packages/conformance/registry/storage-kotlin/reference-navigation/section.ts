import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-kotlin",
  order: 20,
  defaults: {
    section: "Reference Navigation & URL Parsing",
  },
});

export const row = bindKotlinStorageRow(section);
