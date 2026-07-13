import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SOURCE_ROOT = join(import.meta.dir, '..', '..', 'src');
const CREDENTIAL_BINDING = /\b(?:ProjectScope|fromServiceAccount|getDeploy|memoizeTtl)\b/;
const STATIC_DEPENDENCY =
  /(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/g;
const DYNAMIC_DEPENDENCY = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('credential ownership', () => {
  it('keeps retained credential primitives out of deployment imports', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SOURCE_ROOT)) {
      const name = relative(SOURCE_ROOT, file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(STATIC_DEPENDENCY)) {
        const [, bindings = '', specifier = ''] = match;
        if (
          specifier.includes('deploy') &&
          (CREDENTIAL_BINDING.test(bindings) || bindings.includes('*'))
        ) {
          offenders.push(`${name}: ${specifier}`);
        }
      }
      for (const match of source.matchAll(DYNAMIC_DEPENDENCY)) {
        const [, specifier = ''] = match;
        if (specifier.includes('deploy') && CREDENTIAL_BINDING.test(source)) {
          offenders.push(`${name}: ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
