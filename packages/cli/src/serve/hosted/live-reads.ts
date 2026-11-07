/**
 * Service reads on a live host. Production's data needs a credential pyric
 * does not hold, so a live host sends a data read to a connected tab of the
 * app (`bridge/server/tab-tools.ts`), which reads as the signed-in user. With
 * no tab that handles the read, the answer is live mode's refusal, never the
 * sandbox's data. Rules tooling, local logs, sandbox and assurance methods,
 * and writes keep their own path.
 *
 * Both of the host's surfaces route here: a direct command or `pyric mcp`
 * service call by method key (`firestore.getDoc`), and a forwarded tool on
 * `/__pyric/mcp` by tool name (`firestore_get_document`).
 */
import type { ToolResult } from 'pyric/sandbox/internal';
import type { TabTools } from '../../bridge/server/tab-tools.js';
import { METHODS_BY_KEY } from '../../bridge/surface/methods/registry.js';
import type { OperationResult } from '../../bridge/surface/types.js';
import type { HostedMethodRequest } from './method-protocol.js';

/** The code of every live mode refusal, as `@pyric/live` gives it. */
const LIVE_REFUSED = 'PYRIC_LIVE_REFUSED';

/** The services whose read methods return the project's data. */
const DATA_SERVICES: ReadonlySet<string> = new Set(['firestore', 'database', 'storage', 'auth']);

/** Reads of a data service that need no production data, and so stay local. */
const LOCAL_READS: ReadonlySet<string> = new Set(['firestore.extractIndexes', 'auth.whoami', 'auth.sessions']);

/** Data reads outside the data services. */
const OTHER_DATA_READS: ReadonlySet<string> = new Set(['ai_logic.status']);

/** Forwarded tools on `/__pyric/mcp` that read the project's data. */
const FORWARDED_DATA_READS: ReadonlySet<string> = new Set([
  'firestore_get_document',
  'firestore_list_documents',
  'firestore_query_where',
  'rtdb_crawl_structure',
  'auth_get_user',
  'auth_list_users',
]);

/** Reads that need the Admin credential, which no tab holds: refused, never routed. */
const CREDENTIAL_READS: ReadonlySet<string> = new Set(['auth.createCustomToken', 'auth_custom_token']);

function isTabMethodRead(key: string): boolean {
  const method = METHODS_BY_KEY.get(key);
  const isRead = method?.effect === 'read';
  if (!isRead) return false;
  if (LOCAL_READS.has(key)) return false;
  return DATA_SERVICES.has(method.tool) || OTHER_DATA_READS.has(key);
}

function liveReadRefusal(name: string, reason: string): ToolResult {
  return { ok: false, summary: `Live mode refused ${name}: ${reason}`, data: { code: LIVE_REFUSED } };
}

/**
 * Where a live host answers the call `name` (a method key or a forwarded
 * tool name): a tab's answer, a refusal, or undefined when it runs locally.
 */
export function tabCallRoute(tabs: TabTools, name: string, args: Record<string, unknown>): Promise<ToolResult> | ToolResult | undefined {
  const needsCredential = CREDENTIAL_READS.has(name);
  if (needsCredential) return liveReadRefusal(name, 'it needs the Admin credential, which pyric does not hold.');
  const readsData = FORWARDED_DATA_READS.has(name) || isTabMethodRead(name);
  if (!readsData) return undefined;
  return tabs.call(name, args) ?? liveReadRefusal(name,
    'no open tab of the app answers it. Open the app in a browser and sign in, then call it again to read live data.');
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
  const routed = liveTabs === undefined ? undefined : tabCallRoute(liveTabs, call.key, call.args);
  return routed ?? runLocal();
}
