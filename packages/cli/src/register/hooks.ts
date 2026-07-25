/**
 * `module.register()` fallback hooks — the ASYNC (loader-thread) variant of
 * the specifier rewrite, used only on Node 22.x older than 22.15 where the
 * sync `module.registerHooks` API doesn't exist yet.
 *
 * Runs on Node's loader thread, so it intercepts ESM `import` ONLY — CJS
 * `require('firebase-admin')` is NOT rewritten on this path (index.ts logs
 * a warning saying exactly that). Keep this module free of side effects and
 * heavy imports: the loader thread re-instantiates it in isolation.
 */
import { mapFirebaseSpecifier } from './mapping.js';

interface ResolveContext {
  parentURL?: string;
  conditions: string[];
  importAttributes: Record<string, string>;
}
interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}

export function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: (specifier: string, context?: ResolveContext) => Promise<ResolveResult>,
): Promise<ResolveResult> {
  const mappedSpecifier = mapFirebaseSpecifier(specifier, context.parentURL);
  const hasMappedSpecifier = mappedSpecifier !== null && mappedSpecifier !== undefined;
  if (hasMappedSpecifier) {
    return nextResolve(mappedSpecifier, context);
  }
  return nextResolve(specifier, context);
}
