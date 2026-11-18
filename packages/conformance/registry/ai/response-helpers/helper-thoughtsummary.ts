import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ["thoughtSummary"],
  api: 'response.thoughtSummary()',
  behavior: '`thoughtSummary()` returns undefined when no part is flagged `thought: true`, the captured lite-model case',
  automation: 'shape-backed',
  evidence: '`unit:upstream-ai-probes.test.ts` (I3 thoughtSummary from thought parts) + Capture ai-thinking-thought-parts replayed by `unit:helpers-schema.test.ts` test `ai#helper-thoughtsummary`',
  oracleObservations: ['ai-thinking-thought-parts'],
  conformanceTests: ['upstream-ai-probes.test.ts', 'helpers-schema.test.ts'],
});
