import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-kotlin",
  order: 80,
  defaults: {
    section: "Security Rules, App Check & Error Mapping",
  },
});

export const row = bindKotlinStorageRow(section);
