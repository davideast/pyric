import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-flutter",
  order: 50,
  defaults: {
    section: "Metadata Operations",
  },
});

export const row = bindFlutterStorageRow(section);
