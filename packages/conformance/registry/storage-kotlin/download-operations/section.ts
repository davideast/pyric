import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-kotlin",
  order: 40,
  defaults: {
    section: "Download Operations & URLs",
  },
});

export const row = bindKotlinStorageRow(section);
