import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-kotlin",
  order: 60,
  defaults: {
    section: "List Pagination & Object Deletion",
  },
});

export const row = bindKotlinStorageRow(section);
