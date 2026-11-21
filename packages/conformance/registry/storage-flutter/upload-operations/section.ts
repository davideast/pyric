import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-flutter",
  order: 30,
  defaults: {
    section: "Upload Operations",
  },
});

export const row = bindFlutterStorageRow(section);
