#!/usr/bin/env bun
/**
 * Inline every `.rules` file under `src/modules/stdlib/` as a TypeScript
 * string map so the resolver can run in the browser without
 * `readFileSync`. The on-disk priority-4 fallback in
 * `modules/resolver.ts` stays for Node consumers; this generator is
 * what makes `resolver-browser.ts` work.
 *
 * Reads `src/modules/stdlib/<name>.rules` for every file and writes
 * a single `src/modules/stdlib-content.ts` that exports:
 *
 *   export const STDLIB_INLINE: Record<string, string> = {
 *     auth: `...`,
 *     validation: `...`,
 *     ...
 *   };
 *
 * The generated file is checked in. Running this script after editing
 * a `.rules` file is the same workflow as regenerating the inlined
 * grammar — the header makes accidental hand-edits obvious in code
 * review. Wired into `prebuild` so `bun run build` always picks up
 * edits without manual remembering.
 *
 * Run:
 *   bun packages/pyric/scripts/inline-stdlib.ts
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(__dirname);
const STDLIB_DIR = join(PACKAGE_ROOT, 'src', 'rules', 'modules', 'stdlib');
const OUT_PATH = join(PACKAGE_ROOT, 'src', 'rules', 'modules', 'stdlib-content.ts');

const files = readdirSync(STDLIB_DIR)
  .filter((f) => f.endsWith('.rules'))
  .sort();

const entries = files.map((file) => {
  const name = file.replace(/\.rules$/, '');
  const content = readFileSync(join(STDLIB_DIR, file), 'utf-8');
  // Escape backticks + `${` so the source survives template-literal
  // wrapping. Backslashes escape themselves first to avoid double-
  // unescaping at runtime.
  const escaped = content
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  return { name, content: escaped };
});

const lines: string[] = [
  '/**',
  ' * GENERATED FILE — do not edit by hand.',
  ' * Regenerate via `bun run inline-stdlib` (or `bun run build`, which',
  ' * runs the generator as part of `prebuild`).',
  ' *',
  ' * Mirror of every `.rules` file under `src/modules/stdlib/`,',
  ' * inlined as TypeScript string literals so the resolver can run',
  ' * in the browser. See `scripts/inline-stdlib.ts`.',
  ' */',
  '',
  'export const STDLIB_INLINE: Record<string, string> = {',
];
for (const e of entries) {
  lines.push(`  ${e.name}: \`${e.content}\`,`);
}
lines.push('};', '');

writeFileSync(OUT_PATH, lines.join('\n'));
console.log(`inlined ${entries.length} stdlib module(s) into ${OUT_PATH.replace(PACKAGE_ROOT + '/', '')}`);
