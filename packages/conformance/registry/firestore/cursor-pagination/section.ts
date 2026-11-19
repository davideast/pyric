import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 120,
  defaults: {
    section: "Cursor pagination — `startAt` / `startAfter` / `endAt` / `endBefore`",
    api: "Cursor pagination",
    status: "conforms",
  },
});

export const row = section.row;
