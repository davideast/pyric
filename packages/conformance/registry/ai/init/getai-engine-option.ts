import { ENGINE_EXCEPTION, ENGINE_NOTE } from '../defaults.ts';
import { row } from './section.ts';

export default row({
  order: 50,
  featureKeys: ["getAI"],
  api: 'getAI(target, options)',
  behavior: '`getAI(sandbox, { backend: new GoogleAIBackend(), engine: { kind: "scripted" } })` selects the scripted engine explicitly and behaves identically to the zero-config default',
  automation: 'sandbox-only',
  evidence: '`unit:instances.test.ts` test `ai#getai-engine-option` (engine seam per packages/conformance/docs/ai/cdd-deltas.md)',
  conformanceTests: ['instances.test.ts'],
  exceptionReason: ENGINE_EXCEPTION,
  notes: ENGINE_NOTE,
});
