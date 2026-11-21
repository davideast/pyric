import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-swift",
  order: 10,
  defaults: {
    section: "Storage Instance & Configuration",
  },
});

export const row = bindSwiftStorageRow(section);
