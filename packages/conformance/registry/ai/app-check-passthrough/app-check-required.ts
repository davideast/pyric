import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: ['generateContent'],
  api: 'generateContent without App Check in production AI mode',
  behavior: 'On an app that never initialized App Check, `firebase/ai` sends no `X-Firebase-AppCheck` header. A project that enforces App Check for AI Logic rejects the request: HTTP 401, `UNAUTHENTICATED`, message `Firebase App Check token is invalid.`, the same for a malformed header, the SDK placeholder token and a tampered token, and for `streamGenerateContent` and `countTokens` with no header, and 200 for a valid token. Enforcement is required from a date each project can set, up to January 21, 2027, and an unenforced project can answer differently before then: one answered 403 `PERMISSION_DENIED` (`Firebase AI Logic has been deactivated in this project. ...`), and another answered 200 to all of them.',
  evidence: 'captures `app-check-ai-gate-wire` (all five cases on the wire, and stream and countTokens with no header) and `app-check-client-ai-header` (`noAppCheck`), both read while enforcement was `ENFORCED` (2026-11-03), replayed by the pass-through suite. `earlier-captures/ai-logic-refusal-unenforced.json` records the 403 from an unenforced project (2026-10-22).',
  oracleObservations: ['app-check-ai-gate-wire', 'app-check-client-ai-header'],
  risk: ['error-code', 'specific-value'],
  riskScore: 2,
  riskReasons: ['asserts production error status and message text that can drift on re-capture'],
  notes: 'Sandbox AI mode refuses the same requests with the same envelope (rows `ai#sandbox-app-check-*`, section App Check in sandbox AI mode).',
});
