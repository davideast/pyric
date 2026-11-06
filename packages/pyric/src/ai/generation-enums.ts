/** Runtime values from the installed Firebase SDK. */

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
