/** Encodings accepted by Firebase Storage string uploads. */
export const StringFormat = {
  RAW: "raw",
  BASE64: "base64",
  BASE64URL: "base64url",
  DATA_URL: "data_url",
} as const;
export type StringFormat = (typeof StringFormat)[keyof typeof StringFormat];
