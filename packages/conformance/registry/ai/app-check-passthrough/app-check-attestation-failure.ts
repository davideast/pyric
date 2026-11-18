import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ['generateContent'],
  api: 'generateContent when App Check attestation fails',
  behavior: 'When the token exchange is refused, `firebase/ai` sends the SDK placeholder token (base64 of `{"error":"UNKNOWN_ERROR"}`), which AI Logic treats as an invalid token (row `ai#app-check-required`); with `useLimitedUseAppCheckTokens` it throws `AI/error` naming `appCheck/fetch-status-error` before sending any request.',
  evidence: 'capture `app-check-client-invalid-debug-token` records an enforced project answering the placeholder token with the 401 (`aiRequest`, `aiGeneration`), which the pass-through suite replays. `earlier-captures/ai-logic-refusal-unenforced.json` records the 403 an unenforced project sent.',
  oracleObservations: ['app-check-client-invalid-debug-token'],
});
