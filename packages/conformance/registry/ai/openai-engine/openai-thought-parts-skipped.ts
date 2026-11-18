import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: [],
  queryable: false,
  api: 'openai engine',
  behavior: 'Parts flagged `thought: true` in history are skipped when replaying to an OpenAI upstream',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#openai-thought-parts-skipped` (lossy translation edge from ticket #96)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
