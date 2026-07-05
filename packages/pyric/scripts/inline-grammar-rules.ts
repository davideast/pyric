#!/usr/bin/env bun
/**
 * Inline `.ohm` grammar files as TypeScript string exports so the parser
 * stays browser-safe (no `readFileSync`, no `__dirname`, no `import.meta.url`).
 *
 * Reads every `.ohm` file under src/ and writes a sibling
 * `<name>.ohm.generated.ts` that exports the source as a string. The
 * generated files are checked in — running this script after editing a
 * `.ohm` file is the same workflow as regenerating any other artifact
 * (e.g., a snapshot test). The header makes accidental hand-edits
 * obvious in code review.
 *
 * Run:
 *   bun packages/sdk/scripts/inline-grammar.ts
 *
 * Wired into `prebuild` so `bun run build` always picks up grammar
 * edits without the developer having to remember.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(__dirname);
const SRC = join(PACKAGE_ROOT, 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith('.ohm')) {
      out.push(full);
    }
  }
  return out;
}

function constName(file: string): string {
  // FirestoreRules.ohm → FIRESTORE_RULES_OHM_SOURCE
  const name = basename(file, '.ohm')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toUpperCase();
  return `${name}_OHM_SOURCE`;
}

const sources = walk(SRC);
let written = 0;
for (const src of sources) {
  const text = readFileSync(src, 'utf-8');
  const dest = `${src}.generated.ts`;
  const exportName = constName(src);
  // Escape, in order: backslashes first (template literal would
  // otherwise process `\n` etc.), then backticks, then `${` (template
  // interpolation). The `.ohm` grammar contains literal backslashes
  // (e.g. `"\\"` in stringEscapeChar) that must round-trip byte-exact.
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
  const body =
    `// AUTO-GENERATED — do not edit by hand. Regenerate via:\n` +
    `//   bun packages/sdk/scripts/inline-grammar.ts\n` +
    `// Source: ${basename(src)}\n` +
    `\n` +
    `export const ${exportName} = \`${escaped}\`;\n`;
  writeFileSync(dest, body);
  written++;
}
console.log(`inlined ${written} grammar file(s) into .generated.ts siblings`);
