/**
 * Manifest inspection helpers used by the isolated Functions child (`child.ts`):
 * resolves dynamic global/per-endpoint `timeoutSeconds` for heartbeat limits
 * and registers declared `secretEnvironmentVariables` with the child redactor.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { callableOnCallFamily } from './callable/discovery.js';
import { isProtectedFunctionsEnvKey } from './dotenv.js';
import { resolveTimeoutSecondsOption } from './endpoint-options.js';
import { listFirebaseEndpoints } from './endpoints.js';
import { httpOnRequestFamily } from './http/discovery.js';
import type { SecretRedactor } from './secret-redaction.js';

function resolveGlobalTimeoutSeconds(entry: string): number | undefined {
  let functionsMain: string;
  try {
    functionsMain = createRequire(entry).resolve('firebase-functions');
  } catch (error: unknown) {
    // Synthetic test fixtures without a `firebase-functions` install have no global options.
    void error;
    return undefined;
  }
  const libDir = dirname(dirname(functionsMain));
  const cjsOptionsPath = join(libDir, 'v2/options.js');
  if (!existsSync(cjsOptionsPath)) {
    return undefined;
  }
  try {
    const optionsModule = createRequire(functionsMain)(cjsOptionsPath) as {
      getGlobalOptions?: () => { timeoutSeconds?: unknown };
    };
    const rawTimeout = optionsModule.getGlobalOptions?.()?.timeoutSeconds;
    const parsedTimeout = resolveTimeoutSecondsOption(rawTimeout, process.env);
    if (parsedTimeout.ok && parsedTimeout.timeoutSeconds !== undefined) {
      return parsedTimeout.timeoutSeconds;
    }
  } catch (error: unknown) {
    // Optional inspection fallback when `v2/options.js` layout differs.
    void error;
  }
  return undefined;
}

/** Collect effective `timeoutSeconds` across all active non-HTTP triggers. */
export function collectActiveEventTimeouts(
  entry: string,
  exported: Record<string, unknown>,
  unsupportedNames: ReadonlySet<string>,
): Array<number | null> {
  const globalTimeoutSeconds = resolveGlobalTimeoutSeconds(entry);
  const timeouts: Array<number | null> = [];
  for (const { exportName, callable } of listFirebaseEndpoints(exported)) {
    const endpoint = callable.__endpoint;
    if (!endpoint) continue;
    if (unsupportedNames.has(exportName)) continue;
    if (httpOnRequestFamily.claims(endpoint) || callableOnCallFamily.claims(endpoint)) {
      continue;
    }
    const rawTimeout = endpoint.timeoutSeconds;
    const parsedTimeout = resolveTimeoutSecondsOption(rawTimeout, process.env);
    if (parsedTimeout.ok && parsedTimeout.timeoutSeconds !== undefined) {
      timeouts.push(parsedTimeout.timeoutSeconds);
    } else if (rawTimeout === undefined && globalTimeoutSeconds !== undefined) {
      timeouts.push(globalTimeoutSeconds);
    } else {
      timeouts.push(null);
    }
  }
  return timeouts;
}

/** Register process env values for any endpoint-declared secret env vars with `redactor`. */
export function registerDeclaredEndpointSecrets(
  exported: Record<string, unknown>,
  redactor: SecretRedactor,
): void {
  const values: string[] = [];
  for (const { callable } of listFirebaseEndpoints(exported)) {
    const entries = callable.__endpoint?.secretEnvironmentVariables;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const key = entry?.key;
      if (typeof key !== 'string' || key.length === 0 || isProtectedFunctionsEnvKey(key)) {
        continue;
      }
      const value = process.env[key];
      if (typeof value === 'string' && value.length > 0) {
        values.push(value);
      }
    }
  }
  if (values.length > 0) {
    redactor.addValues(values);
  }
}
