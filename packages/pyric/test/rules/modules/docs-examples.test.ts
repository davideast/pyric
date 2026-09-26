/**
 * The Rules examples in the standard library guide resolve. A block whose
 * first line is a `// <path>.rules` comment is written to that path in a
 * scratch project; every `2+modules` block with a service is then resolved
 * against that project, so an example that imports another example's file
 * is resolved the way a reader would lay the files out.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveModules } from '../../../src/rules/modules/resolver.js';

const GUIDE = join(import.meta.dir, '../../../../site-docs/src/content/secure/rules-standard-library.md');

function rulesBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```rules\n([\s\S]*?)```/g)].map((m) => m[1]);
}

describe('the rules standard library guide', () => {
  const blocks = rulesBlocks(readFileSync(GUIDE, 'utf8'));
  const project = mkdtempSync(join(tmpdir(), 'pyric-guide-'));
  for (const block of blocks) {
    const path = /^\/\/ ([\w./-]+\.rules)\n/.exec(block)?.[1];
    if (!path) continue;
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), block);
  }
  const sources = blocks.filter((b) => /rules_version = '2\+modules'/.test(b) && /\bservice \w/.test(b));

  test('has examples to check', () => {
    expect(sources.length).toBeGreaterThanOrEqual(2);
  });

  for (const [i, source] of sources.entries()) {
    const first = source.split('\n').find((line) => line.startsWith('import')) ?? `example ${i + 1}`;
    test(`resolves the example that starts with: ${first}`, () => {
      const result = resolveModules(source, { basePath: project });
      if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
      expect(result.data.resolved).not.toMatch(/^\s*import /m);
    });
  }
});
