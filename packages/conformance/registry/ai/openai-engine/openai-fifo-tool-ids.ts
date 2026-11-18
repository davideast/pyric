import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 20,
  featureKeys: [],
  queryable: false,
  api: 'openai engine',
  behavior: 'OpenAI `tool_call` ids are matched FIFO against Gemini functionResponse parts when replaying tool history',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#openai-fifo-tool-ids` (lossy translation edge from ticket #96)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE + ' Documented lossy edge: Gemini ids are optional, so ordering is the join key.',
});
