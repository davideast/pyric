import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 40,
  featureKeys: [],
  queryable: false,
  api: 'openai engine',
  behavior: 'The OpenAI `[DONE]` sentinel is never forwarded as a Gemini chunk; every emitted chunk is a parseable Gemini envelope',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#openai-done-not-forwarded` (lossy translation edge from ticket #96)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
