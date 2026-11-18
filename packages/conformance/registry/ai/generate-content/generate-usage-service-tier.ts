import { row } from './section.ts';

export default row({
  order: 60,
  featureKeys: ["generateContent"],
  api: 'generateContent()',
  behavior: '`usageMetadata.serviceTier` rides the wire even though the 2.12.0 SDK typings do not declare it',
  automation: 'shape-backed',
  evidence: 'Capture ai-generate-minimal-envelope (usageServiceTierPresent) replayed by packages/pyric/test/ai/generate-content.test.ts test `ai#generate-usage-service-tier`',
  oracleObservations: ['ai-generate-minimal-envelope'],
  conformanceTests: ['generate-content.test.ts'],
});
