import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/chat-errors-abort-oracle.test.ts';

export default row({
  order: 70,
  featureKeys: ['AIError', 'AIErrorCode'],
  api: 'AIError',
  behavior:
    'HTTP failures surface as `AIError` with an `AIErrorCode` code and `customErrorData` carrying `status`, `statusText`, and `errorDetails`',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-error-bad-api-key` and `ai-offline-chat-roles-errors-and-abort` replayed across in-process (`chat-errors-abort-oracle.test.ts`, `errors-counttokens.test.ts`), worker-host (`ai-chat-errors-abort.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-error-bad-api-key', 'ai-offline-chat-roles-errors-and-abort'],
  conformanceTests: ['chat-errors-abort-oracle.test.ts', 'errors-counttokens.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-chat-errors-abort.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-ERROR-AIERROR-SHAPE',
      observation: 'ai-offline-chat-roles-errors-and-abort',
      expect: { fetchCalls: 0 },
      probe: PROBE,
      guards:
        'AIError extends FirebaseError with AIErrorCode code and customErrorData preserving status, statusText, and errorDetails.',
    },
  ],
  notes: 'The client-side error class shape wraps the oracle-backed wire envelope.',
});
