import { row } from './section.ts';

export default row({
  order: 70,
  behavior: "Cancels with `auth/popup-closed-by-user` when the user dismisses the popup (prod)",
  status: "unsupported",
  evidence: "not modeled — would require the host to expose a \"cancel\" affordance on the mock",
  risk: ["specific-value","error-code"],
  riskScore: 5,
  riskReasons: ["asserts 1 specific value(s)","asserts Firebase error code(s): `auth/popup-closed-by-user`"],
  automation: "unsupported",
  exceptionReason: "unsupported / intentionally out of scope",
});
