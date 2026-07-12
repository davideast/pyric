/** Lightweight tool-name contract used by browser bridge discovery. */
export const ASSURANCE_TOOL_NAMES = [
  "firebase_assurance_attach",
  "firebase_assurance_start",
  "firebase_assurance_map",
  "firebase_assurance_define",
  "firebase_assurance_propose",
  "firebase_assurance_run",
  "firebase_assurance_inspect",
  "firebase_assurance_minimize",
  "firebase_assurance_verify",
  "firebase_assurance_export",
] as const;

export type AssuranceToolName = (typeof ASSURANCE_TOOL_NAMES)[number];
