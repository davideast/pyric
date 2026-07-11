/**
 * Shared support for the ai oracle conformance suites.
 *
 * Every suite loads the `pyric/ai` and `pyric/ai/scripting` entry points
 * lazily so a missing entry point (a stale build) surfaces as one explained
 * failure per row id rather than an unnamed hook failure. Assertions are real
 * and derived from the registry rows and the frozen ai-* observations under
 * scripts/oracle/observations; generated text values are never asserted unless
 * the scripted engine was explicitly scripted to return them.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OBSERVATIONS = join(import.meta.dir, '..', '..', '..', '..', 'scripts', 'oracle', 'observations');

/** Load an observation's distilled `behavior` facts for replay assertions. */
export function observedBehavior(name: string): Record<string, any> {
  const parsed = JSON.parse(readFileSync(join(OBSERVATIONS, `${name}.json`), 'utf8'));
  return parsed.behavior as Record<string, any>;
}

export interface AiSeam {
  /** Module namespace of 'pyric/ai' (getAI, getGenerativeModel, backends, Schema, ...). */
  ai: any;
  /** Module namespace of 'pyric/ai/scripting' (script, encodeSse, ...). */
  scripting: any;
  /** Module namespace of 'pyric/sandbox'. */
  sandboxMod: any;
}

async function loadOrExplain(specifier: string): Promise<any> {
  try {
    return await import(specifier);
  } catch (cause) {
    throw new Error(
      `'${specifier}' failed to resolve. The ai oracle conformance suite replays captures against the built pyric/ai mirror; rebuild the package (cd packages/pyric && bun run build) if this entry point is missing.`,
      { cause: cause as Error },
    );
  }
}

export async function loadAiSeam(): Promise<AiSeam> {
  const sandboxMod = await import('pyric/sandbox');
  const ai = await loadOrExplain('pyric/ai');
  const scripting = await loadOrExplain('pyric/ai/scripting');
  return { ai, scripting, sandboxMod };
}

let seamPromise: Promise<AiSeam> | undefined;

/**
 * Memoized seam loader, called at the top of every row test (not in a
 * beforeAll) so each row id reports its own red failure with the
 * RED BY DESIGN message instead of one unnamed hook failure per file.
 */
export function aiSeam(): Promise<AiSeam> {
  seamPromise ??= loadAiSeam();
  return seamPromise;
}

/** Data (non-function) keys of a response object, sorted. The enhanced
 * response adds helper methods; the wire envelope facts concern data keys. */
export function dataKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((key) => typeof value[key] !== 'function')
    .sort();
}

export const PROBE_MODEL = 'gemini-flash-lite-latest';
