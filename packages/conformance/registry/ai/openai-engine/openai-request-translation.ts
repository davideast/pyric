import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 10,
  featureKeys: [],
  queryable: false,
  api: 'openai engine',
  behavior: 'Gemini `contents` and `systemInstruction` translate to OpenAI chat messages, and the OpenAI response translates back to a Gemini envelope with role `model`',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` test `ai#openai-request-translation` (translation exercised against a local OpenAI-compatible mock)',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
