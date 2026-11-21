import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-swift",
  order: 70,
  defaults: {
    section: "Observable Storage Tasks & Controls",
  },
});

export const row = bindSwiftStorageRow(section);
