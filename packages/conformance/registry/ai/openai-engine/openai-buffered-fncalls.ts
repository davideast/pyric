import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 30,
  featureKeys: [],
  queryable: false,
  api: 'openai engine',
  behavior: 'Streamed OpenAI tool_call deltas are buffered; the Gemini stream emits whole functionCall parts with parsed args, never partial fragments. Arguments that are not valid JSON end the stream with finishReason `MALFORMED_FUNCTION_CALL`, as the unary translation does, so the response helpers throw `Candidate was blocked due to MALFORMED_FUNCTION_CALL`',
  automation: 'sandbox-only',
  evidence: '`unit:engines.test.ts` tests `ai#openai-buffered-fncalls` (lossy translation edge; malformed arguments end the stream with `MALFORMED_FUNCTION_CALL` and `functionCalls()` throws). `MALFORMED_FUNCTION_CALL` is in the `badFinishReasons` set of the installed `@firebase/ai`, so its helpers throw `AIError` `response-error` for it',
  conformanceTests: ['engines.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
