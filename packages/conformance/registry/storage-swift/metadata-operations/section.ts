import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-swift",
  order: 50,
  defaults: {
    section: "Metadata Operations",
  },
});

export const row = bindSwiftStorageRow(section);
