import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['generateContent'],
  api: 'generateContent({ contents: [{ parts }] }) with no role',
  behavior: "AI-21: production answers contents with no role (200); pyric refuses it (400, Role '' is not supported).",
  notes: 'Production answered with finish reason STOP and a candidate with role `model`.',
  evidence: '`oracle:ai-request-edge-roleless-contents`.',
  oracleObservations: ['ai-request-edge-roleless-contents'],
});
