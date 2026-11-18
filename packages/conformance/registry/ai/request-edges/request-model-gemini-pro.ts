import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['getGenerativeModel', 'generateContent'],
  api: "getGenerativeModel(ai, { model: 'gemini-pro' }).generateContent(prompt)",
  behavior: 'AI-23: production refuses the model gemini-pro (404 NOT_FOUND); pyric answers.',
  notes: 'Production gives the unknown-model message: `models/gemini-pro is not found for API version v1main, ...`.',
  evidence: '`oracle:ai-request-edge-model-gemini-pro`.',
  oracleObservations: ['ai-request-edge-model-gemini-pro'],
});
