import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: ['getAI'],
  api: 'getAI(target)',
  behavior:
    '`getAI(sandbox)` returns an AI handle bound to the sandbox target; a model minted from it answers through the in-process answer engine',
  automation: 'sandbox-only',
  risk: ['structural'],
  riskReasons: ['structural / routing-only claim'],
  evidence:
    '`unit:instances.test.ts` test `ai#getai-sandbox-dispatch` (sandbox-only target overload and in-process answer engine; `FirebaseApp` dispatch is oracle-backed on `ai#getai-app-dispatch`)',
  conformanceTests: ['instances.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
