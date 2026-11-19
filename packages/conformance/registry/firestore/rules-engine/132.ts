import { row } from './section.ts';

export default row({
  order: 60,
  behavior: "Custom claims in `request.auth.token.<claim>`",
  status: "conforms",
  evidence: "`playground:rules-custom-claims`",
  risk: ["specific-field"],
  riskScore: 1,
  riskReasons: ["asserts a specific field/property value"],
  automation: "playground-only",
  exceptionReason: "playground / preview behavior — no firebase-js-sdk counterpart to observe",
});
