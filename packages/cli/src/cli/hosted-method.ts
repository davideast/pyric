import type { Discovered } from '../serve/discovery.js';
import { realpathSync } from 'node:fs';
import { HOSTED_METHOD_PATH, hostedMethodResult } from '../serve/hosted/method-protocol.js';
import type { OperationResult } from '../bridge/surface/types.js';

/** Null means this server does not support hosted service commands. Never opens a local store. */
export async function callHostedMethod(
  host: Discovered,
  key: string,
  args: Record<string, unknown>,
  projectDir: string,
  allowProduction: boolean,
): Promise<OperationResult | null> {
  const lacksInstanceIdentity = host.instanceId === null;
  if (lacksInstanceIdentity) return null;
  const response = await fetch(new URL(HOSTED_METHOD_PATH, host.base), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: host.instanceId, projectDir: realpathSync(projectDir), key, args, allowProduction }),
    signal: AbortSignal.timeout(30_000),
  });
  const lacksMethodEndpoint = response.status === 404;
  if (lacksMethodEndpoint) return null;
  const result = hostedMethodResult.parse(await response.json());
  return result;
}
