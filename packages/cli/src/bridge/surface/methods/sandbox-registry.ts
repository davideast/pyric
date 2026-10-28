/**
 * The records that run wherever the sandbox lives, for a host that keeps its
 * sandbox in a browser.
 *
 * `scripts/generate-surface-manifest.ts` renders `../manifest.sandbox.generated.ts`
 * from the records that declare `runsIn: 'sandbox'`. This module imports only
 * that manifest, never `./registry.ts`, so a browser bundle that loads it
 * reaches none of the bridge's records or the Node modules they import.
 */
import { SANDBOX_METHOD_RECORDS } from '../manifest.sandbox.generated.js';
import { stampRecord, type SandboxMethod } from '../method-types.js';

/** Every sandbox-side method by `<tool>.<method>`. */
export const SANDBOX_METHODS_BY_KEY: ReadonlyMap<string, SandboxMethod> = new Map(
  SANDBOX_METHOD_RECORDS.map(([owner, name, record]) => {
    const method = stampRecord(owner, name, record);
    return [method.key, method];
  }),
);

/** One sandbox-side method by key, or undefined when it runs only in the bridge process. */
export function sandboxMethodByKey(key: string): SandboxMethod | undefined {
  return SANDBOX_METHODS_BY_KEY.get(key);
}
