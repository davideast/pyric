import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-swift",
  order: 30,
  defaults: {
    section: "Upload Operations",
  },
});

export const row = bindSwiftStorageRow(section);
