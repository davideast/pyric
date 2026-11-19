import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 180,
  defaults: {
    section: "Scalar types — `Bytes` / `GeoPoint` / `FieldPath` / `documentId`",
    api: "Scalar types",
    status: "conforms",
  },
});

export const row = section.row;
