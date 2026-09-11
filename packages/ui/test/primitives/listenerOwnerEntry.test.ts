/**
 * The `@pyric/ui/listener-owner` entry must not reach pyric at runtime.
 *
 * An application that uses the hook ships whatever this entry's module graph
 * pulls in. If any module in that graph imported pyric for a value rather
 * than a type, pyric would land in the application's production bundle, which
 * is exactly what the separate entry exists to prevent.
 *
 * The check walks the source graph from the entry, following relative
 * imports, and reads every specifier each module names. Type-only imports
 * (`import type ...`) are erased by `tsc`, so they are allowed; a pyric
 * specifier in any other position is a failure. Reading the source rather
 * than a build keeps the test runnable without a prior `bun run build`, and
 * the `import type` requirement is what makes the source reading equivalent
 * to reading the output.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(HERE, '../../src/listener-owner/index.ts');

/** Every `from '...'` specifier in a module, with its statement text. */
const IMPORT_STATEMENT = /(?:^|\n)\s*(export|import)\s+(type\s+)?([\s\S]*?)from\s+'([^']+)';/g;

interface Specifier {
  text: string;
  typeOnly: boolean;
}

function specifiersOf(source: string): Specifier[] {
  const found: Specifier[] = [];
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    found.push({ text: match[4]!, typeOnly: match[2] !== undefined });
  }
  return found;
}

/** Resolve a relative `.js` specifier back to the `.ts` source it came from. */
function sourcePathFor(from: string, specifier: string): string {
  const target = resolve(dirname(from), specifier);
  for (const candidate of [target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx')]) {
    try {
      readFileSync(candidate, 'utf8');
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`cannot resolve ${specifier} from ${from}`);
}

interface GraphRead {
  modules: string[];
  runtimeSpecifiers: string[];
}

function readGraph(entry: string): GraphRead {
  const modules: string[] = [];
  const runtimeSpecifiers = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (modules.includes(current)) continue;
    modules.push(current);
    const source = readFileSync(current, 'utf8');
    for (const specifier of specifiersOf(source)) {
      if (specifier.text.startsWith('.')) {
        pending.push(sourcePathFor(current, specifier.text));
        continue;
      }
      if (specifier.typeOnly) continue;
      runtimeSpecifiers.add(specifier.text);
    }
  }
  return { modules, runtimeSpecifiers: [...runtimeSpecifiers].sort() };
}

describe('@pyric/ui/listener-owner', () => {
  it('names no pyric specifier in a runtime import', () => {
    const { runtimeSpecifiers } = readGraph(ENTRY);
    const pyric = runtimeSpecifiers.filter(
      (specifier) => specifier === 'pyric' || specifier.startsWith('pyric/'),
    );
    expect(pyric).toEqual([]);
  });

  it('imports react and nothing else at runtime', () => {
    const { runtimeSpecifiers } = readGraph(ENTRY);
    expect(runtimeSpecifiers).toEqual(['react']);
  });

  it('reaches only the entry and the hook', () => {
    const { modules } = readGraph(ENTRY);
    expect(modules.length).toBe(2);
  });
});
