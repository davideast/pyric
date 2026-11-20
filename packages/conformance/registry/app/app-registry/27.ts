import { row } from './section.ts';

export default row({
  order: 270,
  featureKeys: ['getAI', 'deleteApp'],
  section: '`FirebaseApp` deletion lifecycle',
  api: 'getAI(app, customEngine); getGenerativeModel(ai); deleteApp(app); retainedModel operation',
  behavior:
    'Served worker mode rejects page-local custom AnswerEngine objects; `getGenerativeModel` throws `app/app-deleted` synchronously on deleted or retained `AI` handles after `deleteApp(app)`, while models already constructed before deletion and equal-config sibling models remain usable',
  status: 'conforms',
  evidence:
    'oracle: `app-production-deleted-ai-model-lifecycle` (firebase 12.19.0) + twin replay: `production-deleted-ai-oracle.test.ts`; focused family and served worker tests: `deleted-service-lifecycle.test.ts` and `app-deletion.pw.ts`',
  risk: ['stateful', 'structural'],
  riskScore: 4,
  riskReasons: ['asserts deleted-container isolation, worker ownership, and sibling survival'],
  automation: 'oracle-backed',
  oracleObservations: ['app-production-deleted-ai-model-lifecycle'],
  conformanceTests: [
    'packages/pyric/test/app/production-deleted-ai-oracle.test.ts',
    'packages/pyric/test/app/deleted-service-lifecycle.test.ts',
    'packages/cli/test/e2e/app-deletion.pw.ts',
  ],
});
