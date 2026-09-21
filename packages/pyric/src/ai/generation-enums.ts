/** Runtime values from the installed Firebase SDK. */

export const ImagenAspectRatio = {
  SQUARE: "1:1",
  LANDSCAPE_3x4: "3:4",
  PORTRAIT_4x3: "4:3",
  LANDSCAPE_16x9: "16:9",
  PORTRAIT_9x16: "9:16",
} as const;
export type ImagenAspectRatio = (typeof ImagenAspectRatio)[keyof typeof ImagenAspectRatio];

export const ImagenPersonFilterLevel = {
  BLOCK_ALL: "dont_allow",
  ALLOW_ADULT: "allow_adult",
  ALLOW_ALL: "allow_all",
} as const;
export type ImagenPersonFilterLevel = (typeof ImagenPersonFilterLevel)[keyof typeof ImagenPersonFilterLevel];

export const ImagenSafetyFilterLevel = {
  BLOCK_LOW_AND_ABOVE: "block_low_and_above",
  BLOCK_MEDIUM_AND_ABOVE: "block_medium_and_above",
  BLOCK_ONLY_HIGH: "block_only_high",
  BLOCK_NONE: "block_none",
} as const;
export type ImagenSafetyFilterLevel = (typeof ImagenSafetyFilterLevel)[keyof typeof ImagenSafetyFilterLevel];

export const InferenceMode = {
  PREFER_ON_DEVICE: "prefer_on_device",
  ONLY_ON_DEVICE: "only_on_device",
  ONLY_IN_CLOUD: "only_in_cloud",
  PREFER_IN_CLOUD: "prefer_in_cloud",
} as const;
export type InferenceMode = (typeof InferenceMode)[keyof typeof InferenceMode];

export const InferenceSource = {
  ON_DEVICE: "on_device",
  IN_CLOUD: "in_cloud",
} as const;
export type InferenceSource = (typeof InferenceSource)[keyof typeof InferenceSource];

export const LiveResponseType = {
  SERVER_CONTENT: "serverContent",
  TOOL_CALL: "toolCall",
  TOOL_CALL_CANCELLATION: "toolCallCancellation",
  GOING_AWAY_NOTICE: "goingAwayNotice",
  SESSION_RESUMPTION_UPDATE: "sessionResumptionUpdate",
} as const;
export type LiveResponseType = (typeof LiveResponseType)[keyof typeof LiveResponseType];
