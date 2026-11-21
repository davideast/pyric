import { defineRowSection } from '../../section-rows.ts';
import { bindSwiftStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-swift",
  order: 80,
  defaults: {
    section: "Security Rules, Auth Coupling & Error Mapping",
  },
});

export const row = bindSwiftStorageRow(section);
