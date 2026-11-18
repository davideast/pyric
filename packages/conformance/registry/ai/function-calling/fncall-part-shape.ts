import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ["functionCall"],
  api: 'functionCall parts',
  behavior: 'A functionCall part carries the key set `args`, `id`, `name`, and `args` arrives as a parsed JSON object, not a string',
  automation: 'shape-backed',
  evidence: 'Capture ai-function-call-shape (functionCallKeySet, argsIsObjectNotString) replayed by packages/pyric/test/ai/function-calling.test.ts test `ai#fncall-part-shape`',
  oracleObservations: ['ai-function-call-shape'],
  conformanceTests: ['function-calling.test.ts'],
  notes: 'The parsed-object args shape is the load-bearing difference from OpenAI tool_calls.',
});
