import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: ['generateContentStream', 'countTokens'],
  api: 'generateContentStream and countTokens without App Check in sandbox AI mode',
  behavior: 'Streaming and `countTokens` are refused with the same 401 `AIError` as `generateContent`. In process `generateContentStream` rejects before any chunk; on the SharedWorker and Node host planes the error reaches the caller through the stream and `response`, as other request errors do there.',
  automation: 'unit-backed',
  evidence: 'AI Logic applies App Check to every request (https://firebase.google.com/docs/ai-logic/app-check). Capture `app-check-ai-gate-wire` records an enforced project answering both with no header with the same 401 envelope as `generateContent` (`streamGenerateContentNoHeader`, `countTokensNoHeader`). Unit-backed by the gate suite and the worker protocol suite.',
});
