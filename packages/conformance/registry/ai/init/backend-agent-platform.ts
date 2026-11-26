import { row } from './section.ts';

export default row({
  order: 55,
  featureKeys: ['AgentPlatformBackend', 'BackendType'],
  api: 'AgentPlatformBackend(location?)',
  status: 'unverified',
  automation: 'unverified',
  behavior:
    '`new AgentPlatformBackend(location?)` constructs a `Backend` with `backendType === BackendType.AGENT_PLATFORM` and `location` defaulting to `\"global\"` when omitted or empty; `getAI` keys distinct handles per `(owner, location)`, normalizes model resources to `publishers/google/models/<name>`, and formats sandbox error URLs under `locations/<location>/...`',
  evidence:
    '`unit:agent-platform-backend.test.ts`, `unit:init-backends-oracle.test.ts`, `unit:mirror.test.ts`, `unit:ai-init-backends.test.ts` -- verified differentially against `@firebase/ai@3.1.0` across in-process, SharedWorker, and registered Node planes; awaiting live production capture (`ai-logic` / `ai-request-edge`) to flip to `conforms`',
  risk: ['specific-value', 'error-code'],
  riskScore: 4,
  riskReasons: [
    'asserts 1 specific value(s)',
    'asserts Firebase error code(s): `fetch-error`, `error`',
  ],
  conformanceTests: ['agent-platform-backend.test.ts', 'init-backends-oracle.test.ts', 'mirror.test.ts'],
  hostConformanceTests: [
    'packages/cli/test/serve/worker/ai-init-backends.test.ts',
    'packages/cli/test/register/ai-agent-platform-backend.test.ts',
  ],
});
