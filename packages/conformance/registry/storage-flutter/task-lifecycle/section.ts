import { defineRowSection } from '../../section-rows.ts';
import { bindFlutterStorageRow } from '../defaults.ts';

export const section = defineRowSection({
  surface: "storage-flutter",
  order: 70,
  defaults: {
    section: "TaskPlatform Streams & Lifecycle Controls",
  },
});

export const row = bindFlutterStorageRow(section);
