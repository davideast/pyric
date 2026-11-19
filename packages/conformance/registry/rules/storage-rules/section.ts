import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage-rules",
  order: 20,
  prefix: "## Storage rules engine — `parseStorageRules` / `evaluateStorageRules` (rules-storage corpus)\n",
  defaults: {
    section: "Rules — `parseStorageRules` / `evaluateStorageRules` / `getStorage(ctx, { rules })`",
    api: "Rules",
    automation: "oracle-backed",
  },
});

export const row = section.row;
