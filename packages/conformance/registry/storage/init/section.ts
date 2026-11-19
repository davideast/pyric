import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 10,
  defaults: {
    section: "`getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?)` — initializer",
    api: "getStorage(app, bucketUrl?)` / `getStorageSandbox(target, options?)",
    automation: "unit-backed",
  },
});

export const row = section.row;
