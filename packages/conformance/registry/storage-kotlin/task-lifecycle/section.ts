import { defineRowSection } from '../../section-rows.ts';
import { bindKotlinStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-kotlin",
  order: 70,
  defaults: {
    section: "StorageTask Controls, Listeners & Coroutine Flows",
  },
});

export const row = bindKotlinStorageRow(section);
