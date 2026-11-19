import { row } from './section.ts';

export default row({
  order: 10,
  behavior: "The removed stateful simulator returned a generate-before-simulate error when no IR had been generated",
  status: "unsupported",
  evidence: "The stateless `simulateRtdbRules(compiled, input)` API requires a compiled rules tree and has no generate-before-simulate lifecycle.",
  automation: "unsupported",
  exceptionReason: "The nullable stateful simulator lifecycle was intentionally removed with RtdbIR.",
});
