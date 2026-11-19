import { row } from './section.ts';

const PROBE = 'packages/pyric/test/ai/generate-helpers-sdk-oracle.test.ts';

export default row({
  order: 30,
  featureKeys: ['functionCalls'],
  api: 'response.functionCalls()',
  behavior:
    '`functionCalls()` returns the `FunctionCall` array from the functionCall parts, args as parsed objects',
  automation: 'oracle-backed',
  evidence:
    'Captures `ai-function-call-shape` and `ai-sdk-response-helpers-functioncalls` replayed across in-process (`generate-helpers-sdk-oracle.test.ts`), worker-host (`ai-generate-helpers-sdk-oracle.test.ts`), and served SharedWorker/Node-host (`test/apps/ai-sandbox-contents-roles`) planes, plus `upstream-ai-probes.test.ts` and `helpers-schema.test.ts`.',
  oracleObservations: [
    'ai-function-call-shape',
    'ai-sdk-response-helpers-functioncalls',
  ],
  conformanceTests: [
    'generate-helpers-sdk-oracle.test.ts',
    'upstream-ai-probes.test.ts',
    'helpers-schema.test.ts',
  ],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-generate-helpers-sdk-oracle.test.ts',
    'test/apps/ai-sandbox-contents-roles/scenario.ts',
  ],
  conformanceChecks: [
    {
      finding: 'AI-HELPER-FUNCTIONCALLS',
      observation: 'ai-sdk-response-helpers-functioncalls',
      expect: {
        helperFunctionCalls: {
          isArray: true,
          count: 1,
          firstName: 'get_weather',
          argsIsPlainObject: true,
          argsHasCityString: true,
          inlineDataPartsIsUndefined: true,
        },
      },
      probe: PROBE,
      guards:
        'EnhancedGenerateContentResponse.functionCalls() extracts FunctionCall objects with decoded plain-object args across planes.',
    },
  ],
});
