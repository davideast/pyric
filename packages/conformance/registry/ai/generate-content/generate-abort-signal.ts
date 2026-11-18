import { row } from './section.ts';

export default row({
  order: 130,
  featureKeys: ["generateContent"],
  api: 'generateContent(request, singleRequestOptions)',
  behavior: 'A pre-aborted `SingleRequestOptions.signal` rejects the call',
  automation: 'unit-backed',
  evidence: '`unit:generate-content.test.ts` test `ai#generate-abort-signal` (no capture; upstream SingleRequestOptions contract)',
  conformanceTests: ['generate-content.test.ts'],
});
