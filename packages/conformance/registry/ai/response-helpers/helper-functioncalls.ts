import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ["functionCalls"],
  api: 'response.functionCalls()',
  behavior: '`functionCalls()` returns the `FunctionCall` array from the functionCall parts, args as parsed objects',
  automation: 'shape-backed',
  evidence: '`unit:upstream-ai-probes.test.ts` (I3 text+functionCall mix) + Capture ai-function-call-shape replayed by `unit:helpers-schema.test.ts` test `ai#helper-functioncalls`',
  oracleObservations: ['ai-function-call-shape'],
  conformanceTests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
});
