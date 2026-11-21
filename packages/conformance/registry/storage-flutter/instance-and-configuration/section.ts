import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-flutter",
  order: 10,
  defaults: {
    section: "Storage Platform Instance & Configuration",
  },
});

export const row = bindFlutterStorageRow(section);
