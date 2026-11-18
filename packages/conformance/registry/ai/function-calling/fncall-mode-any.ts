import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ["functionCall"],
  api: 'toolConfig.functionCallingConfig',
  behavior: 'Mode `ANY` forces a functionCall part in the response and the candidate finishes `STOP`',
  automation: 'shape-backed',
  evidence: 'Capture ai-function-call-shape (captured under mode ANY, finishReason STOP) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-mode-any`',
  oracleObservations: ['ai-function-call-shape'],
  conformanceTests: ['function-calling.test.ts'],
});
