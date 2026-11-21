import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-flutter",
  order: 40,
  defaults: {
    section: "Download Operations & URLs",
  },
});

export const row = bindFlutterStorageRow(section);
