import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-kotlin",
  order: 10,
  defaults: {
    section: "Storage Instance & Configuration",
  },
});

export const row = bindKotlinStorageRow(section);
