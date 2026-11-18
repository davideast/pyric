import { row } from './section.ts';

export default row({
  order: 80,
  featureKeys: ["generateContent"],
  api: 'generateContent(request)',
  behavior: 'A plain string request is wrapped as a single user turn before it reaches the engine',
  automation: 'unit-backed',
  evidence: '`unit:generate-content.test.ts` test `ai#generate-string-request` (no capture; upstream request formatting claim)',
  conformanceTests: ['generate-content.test.ts'],
});
