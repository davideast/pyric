import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['generateContent', 'initializeAppCheck'],
  api: 'generateContent from getAI(app) in sandbox AI mode',
  behavior: 'An app that never initialized App Check gets the `AIError` the SDK throws for an enforced project\'s 401: code `fetch-error`, `customErrorData.status` 401, message `[401 Unauthorized] Firebase App Check token is invalid.` with the request URL. The broker refuses a missing, malformed, placeholder, tampered or expired token with that envelope (401 `UNAUTHENTICATED`) before any engine runs, and answers a sandbox token, including one minted under the debug provider. Pyric\'s guidance goes to the console once per app and to the dev server terminal, beside the error. The sandbox plays an enforced project on every project: enforcement is required from a date each project can set, up to January 21, 2027, and an unenforced project can answer 200 or the earlier 403 before then.',
  evidence: 'captures `app-check-ai-gate-wire` (`noHeader`, `malformedHeader`, `sdkPlaceholderToken`, `tamperedSignature`, `validAdminMintedToken`) and `app-check-client-ai-header` (`noAppCheck`), read while enforcement was `ENFORCED` (2026-11-03), replayed by the gate suite in process and over the worker port; the app scenario drives the in-page, SharedWorker, Node host and registered Node process planes. The 403 the sandbox sent before #1300 came from an unenforced project, kept in `earlier-captures/ai-logic-refusal-unenforced.json`. On main before #1291 the sandbox answered tokenless requests.',
  oracleObservations: ['app-check-ai-gate-wire', 'app-check-client-ai-header'],
  risk: ['error-code', 'specific-value'],
  riskScore: 2,
  riskReasons: ['asserts production error status and message text that can drift on re-capture'],
  notes: 'The request URL in the error names project `sandbox`, as every sandbox-minted AI error does.',
});
