import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: ['startChat', 'generateContent'],
  api: "startChat({ systemInstruction: 'text' }).sendMessage(prompt)",
  behavior: 'AI-22: production refuses a string systemInstruction from startChat (400 INVALID_ARGUMENT); pyric answers.',
  notes: "Production's message: `Invalid value at 'system_instruction' (type.googleapis.com/google.ai.generativelanguage.v1beta.Content)`. The real SDK sends the string unchanged from `startChat`; `getGenerativeModel` wraps it in a Content.",
  evidence: '`oracle:ai-request-edge-string-system-instruction`.',
  oracleObservations: ['ai-request-edge-string-system-instruction'],
});
