import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-flutter",
  order: 80,
  defaults: {
    section: "Security Rules, AuthLens & Error Mapping",
  },
});

export const row = bindFlutterStorageRow(section);
