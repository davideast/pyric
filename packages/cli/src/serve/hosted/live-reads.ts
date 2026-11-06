/**
 * Service reads on a live host. Production's data needs a credential pyric
 * does not hold, so a live host sends a data read to a connected tab of the
 * app (`bridge/server/tab-tools.ts`), which reads as the signed-in user. With
 * no tab that handles the read, the answer is live mode's refusal, never the
 * sandbox's data. Rules tooling, sandbox and assurance methods, and writes
 * keep their own path.
 */
import type { TabTools } from '../../bridge/server/tab-tools.js';
import { METHODS_BY_KEY } from '../../bridge/surface/methods/registry.js';
import type { OperationResult } from '../../bridge/surface/types.js';
import type { HostedMethodRequest } from './method-protocol.js';

/** The code of every live mode refusal, as `@pyric/live` gives it. */
const LIVE_REFUSED = 'PYRIC_LIVE_REFUSED';

/** The services whose reads return the project's data. */
const DATA_SERVICES: ReadonlySet<string> = new Set(['firestore', 'database', 'storage', 'auth', 'functions', 'messaging']);

/** Reads of a data service that need no production data, and so stay local. */
const LOCAL_READS: ReadonlySet<string> = new Set(['firestore.extractIndexes', 'auth.whoami', 'auth.sessions']);

/** Data reads outside the data services. */
const OTHER_DATA_READS: ReadonlySet<string> = new Set(['ai_logic.status']);

/** Whether a live host sends the method `key` to a connected tab. */
export function isLiveTabRead(key: string): boolean {
  const method = METHODS_BY_KEY.get(key);
  const isRead = method?.effect === 'read';
  if (!isRead) return false;
  if (LOCAL_READS.has(key)) return false;
  return DATA_SERVICES.has(method.tool) || OTHER_DATA_READS.has(key);
}

function liveReadRefusal(key: string): OperationResult {
  return {
    ok: false,
    summary: `Live mode refused ${key}: no open tab of the app answers it. ` +
      'Open the app in a browser and sign in, then call it again to read live data.',
    data: { code: LIVE_REFUSED },
  };
}

/**
 * Runs one direct command. `liveTabs` is the bridge's tab tools on a live
 * host and undefined on a sandbox host; `runLocal` runs it on the sandbox.
 */
export async function runHostedMethod(
  liveTabs: TabTools | undefined,
  call: HostedMethodRequest,
  runLocal: () => Promise<OperationResult>,
): Promise<OperationResult> {
  const isSandboxHost = liveTabs === undefined;
  if (isSandboxHost || !isLiveTabRead(call.key)) return runLocal();
  const answer = liveTabs.call(call.key, call.args);
  return answer ?? liveReadRefusal(call.key);
}
