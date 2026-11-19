import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["GoogleAuthProvider","EmailAuthProvider"],
  behavior: "Custom scopes / params / language code",
  status: "unsupported",
  evidence: "sandbox ignores; prod forwards",
  automation: "unsupported",
  exceptionReason: "unsupported / intentionally out of scope",
});
