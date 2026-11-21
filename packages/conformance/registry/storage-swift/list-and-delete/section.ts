import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-swift",
  order: 60,
  defaults: {
    section: "List Pagination & Object Deletion",
  },
});

export const row = bindSwiftStorageRow(section);
