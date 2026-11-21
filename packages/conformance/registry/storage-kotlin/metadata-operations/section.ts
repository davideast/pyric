import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-kotlin",
  order: 50,
  defaults: {
    section: "Metadata Operations & KTX Builders",
  },
});

export const row = bindKotlinStorageRow(section);
