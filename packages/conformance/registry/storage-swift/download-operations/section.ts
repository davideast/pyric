import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-swift",
  order: 40,
  defaults: {
    section: "Download Operations & URLs",
  },
});

export const row = bindSwiftStorageRow(section);
