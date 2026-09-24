/**
 * The Node built-in prototypes whose connect methods the network guard
 * patches, looked up without failing on a runtime that lacks them.
 */
import { createRequire } from 'node:module';

/**
 * The `prototype` of `exportName` in the built-in module `id`, or `undefined`
 * when the module or the export is absent. Bun and Deno ship partial Node
 * built-ins, so a missing prototype is an expected answer, not an error.
 */
function builtinPrototype(id: string, exportName: string): object | undefined {
  const require = createRequire(import.meta.url);
  try {
    const mod = require(id) as Record<string, { prototype?: unknown } | undefined>;
    const prototype = mod[exportName]?.prototype;
    if (typeof prototype === 'object' && prototype !== null) return prototype;
  } catch {
    // Runtime without that module: the other seams still apply.
  }
  return undefined;
}

/** Every prototype found, in lookup order. */
function builtinPrototypes(lookups: readonly (readonly [string, string])[]): object[] {
  const prototypes: object[] = [];
  for (const [id, exportName] of lookups) {
    const prototype = builtinPrototype(id, exportName);
    if (prototype !== undefined) prototypes.push(prototype);
  }
  return prototypes;
}

/**
 * The `http.Agent` and `https.Agent` prototypes. Each carries its own
 * `createConnection`: `http`'s is a copied reference to `net.createConnection`
 * snapshotted at `_http_agent` load time, so patching `net` alone leaves it
 * unguarded whenever `node:http` loaded first.
 */
export function nodeAgentPrototypes(): object[] {
  return builtinPrototypes([
    ['node:http', 'Agent'],
    ['node:https', 'Agent'],
  ]);
}

