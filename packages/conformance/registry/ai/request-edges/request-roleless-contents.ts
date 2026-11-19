import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/hunt-captures.test.ts';

export default row({
  order: 10,
  featureKeys: ['generateContent', 'generateContentStream', 'countTokens'],
  api: 'generateContent({ contents: [{ parts }] }) with no role',
  behavior:
    'Accepts `contents` entries with `parts` and no `role` across unary, streaming, and `countTokens` calls (HTTP 200, `finishReason` `STOP`, candidate content role `model`).',
  notes: 'Production answered with finish reason STOP and a candidate with role `model`.',
  evidence:
    'Capture `ai-request-edge-roleless-contents` replayed across in-process (`hunt-captures.test.ts`), worker-host (`ai-request-edges.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes.',
  oracleObservations: ['ai-request-edge-roleless-contents'],
  conformanceChecks: [
    {
      finding: 'AI-21',
      observation: 'ai-request-edge-roleless-contents',
      expect: { httpStatus: 200, finishReason: 'STOP', contentRole: 'model' },
      probe: PROBE,
      guards: 'Roleless contents entries succeed with finishReason STOP and candidate role model.',
    },
  ],
});
