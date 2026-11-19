import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: "storage",
  order: 80,
  defaults: {
    featureKeys: ["getBlob"],
    section: "`getBlob(ref, maxDownloadSize?)` — read as Blob",
    api: "getBlob(ref, maxDownloadSize?)",
    status: "conforms",
  },
});

export const row = section.row;
