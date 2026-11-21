import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-kotlin",
  order: 30,
  defaults: {
    section: "Upload Operations",
  },
});

export const row = bindKotlinStorageRow(section);
