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
import { canonicalFirebaseSpecifier, mapFirebaseSpecifier } from './mapping.js';
import { resolvesIntoPackage } from './package-identity.js';

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

type NextResolve = (specifier: string, context?: ResolveContext) => Promise<ResolveResult>;

/**
 * A Turbopack-renamed import (`firebase-admin-<hash>/app`, #1443) resolves as
 * given first, and maps by its canonical name only when that landed in the
 * real package, so an unrelated package with such a name stays itself.
 */
async function resolveRenamed(
  specifier: string,
  canonical: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  const renamed = await nextResolve(specifier, context);
  const isRealFirebasePackage = resolvesIntoPackage(renamed.url, canonical);
  if (!isRealFirebasePackage) return renamed;
  const mappedSpecifier = mapFirebaseSpecifier(canonical, context.parentURL);
  if (mappedSpecifier === null) return renamed;
  return nextResolve(mappedSpecifier, context);
}

export function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  const canonical = canonicalFirebaseSpecifier(specifier);
  if (canonical !== null) {
    return resolveRenamed(specifier, canonical, context, nextResolve);
  }
  const mappedSpecifier = mapFirebaseSpecifier(specifier, context.parentURL);
  const hasMappedSpecifier = mappedSpecifier !== null && mappedSpecifier !== undefined;
  if (hasMappedSpecifier) {
    return nextResolve(mappedSpecifier, context);
  }
  return nextResolve(specifier, context);
}
