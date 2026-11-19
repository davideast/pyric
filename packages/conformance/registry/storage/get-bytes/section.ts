import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 70,
  defaults: {
    featureKeys: ["getBytes"],
    section: "`getBytes(ref, maxDownloadSize?)` — read as ArrayBuffer",
    api: "getBytes(ref, maxDownloadSize?)",
    status: "conforms",
  },
});

export const row = section.row;
