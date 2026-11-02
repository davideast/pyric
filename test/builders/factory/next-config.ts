/**
 * Adapts Studio's `next.config.ts` to the Pyric it is pinned to. Since
 * `@pyric/cli` 0.1.0-alpha.25, `withPyric` returns Next's config function
 * `(phase, defaults) => config` instead of a config object, and Studio's
 * config sets fields on what it gets back. Setup makes `buildConfig` take
 * Next's arguments and call the returned function with them, in the start
 * commit beside the Pyric pins.
 *
 * Each edit replaces text that must occur exactly once. When Studio's file
 * no longer has it, setup stops and says which edit, rather than starting a
 * run whose Studio cannot start.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const NEXT_CONFIG = 'next.config.ts';

export interface ConfigEdit {
  name: string;
  from: string;
  to: string;
}

export const WITH_PYRIC_EDITS: readonly ConfigEdit[] = [
  {
    name: 'buildConfig takes Next\'s phase and defaults',
    from: 'export default async function buildConfig(): Promise<NextConfig> {',
    to: 'export default async function buildConfig(phase: string, defaults: { defaultConfig: NextConfig }): Promise<NextConfig> {',
  },
  {
    name: 'withPyric is typed as returning the config function',
    from: '    withPyric: (config: NextConfig, options?: Record<string, unknown>) => any;',
    to: '    withPyric: (config: NextConfig, options?: Record<string, unknown>) => (phase: string, defaults: { defaultConfig: NextConfig }) => Promise<any>;',
  },
  {
    name: 'the config function is awaited',
    from: '  const config = withPyric({',
    to: '  // withPyric returns Next\'s config function since @pyric/cli 0.1.0-alpha.25.\n  const config = await withPyric({',
  },
  {
    name: 'the config function is called with phase and defaults',
    from: '    runtimeChip: true,\n  });',
    to: '    runtimeChip: true,\n  })(phase, defaults);',
  },
];

export class ConfigEditMissing extends Error {}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

/** Applies `edits` to `text`; throws naming the first edit whose text does not occur exactly once. */
export function applyEdits(text: string, edits: readonly ConfigEdit[], file = NEXT_CONFIG): string {
  let result = text;
  for (const edit of edits) {
    const count = occurrences(result, edit.from);
    if (count !== 1) throw new ConfigEditMissing(`${file}: "${edit.name}" expects its text once and found it ${count} times; the withPyric adaptation needs updating for this commit`);
    result = result.replace(edit.from, edit.to);
  }
  return result;
}

/** Adapts Studio's config in place and returns one line per edit, for setup's log. */
export function adaptNextConfig(studio: string): string[] {
  const file = join(studio, NEXT_CONFIG);
  writeFileSync(file, applyEdits(readFileSync(file, 'utf8'), WITH_PYRIC_EDITS));
  return WITH_PYRIC_EDITS.map((edit) => `${NEXT_CONFIG}: ${edit.name}`);
}
