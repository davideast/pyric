#!/usr/bin/env bun
/**
 * Copies runtime asset files (.ohm grammars, stdlib .rules and .json)
 * from src/ into dist/ so that __dirname-based readFileSync calls in the
 * compiled output resolve correctly.
 *
 * Pre-mortem H1 — this file is byte-identical to
 * `packages/sdk/scripts/copy-assets.ts`. Same for `inline-grammar.ts`.
 * Consolidation lift (extract to a shared `scripts/asset-pipeline/`
 * package or hoist to a repo-root script) is deferred until a third
 * package needs the same pipeline. When that happens, replace BOTH
 * copies — drift between them is a silent failure mode (grammar
 * regenerates correctly in one package, stale in the other).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = dirname(__dirname);
const SRC = join(PACKAGE_ROOT, 'src');
const DIST = join(PACKAGE_ROOT, 'dist');

const ASSET_EXTENSIONS = new Set(['.ohm', '.rules', '.json']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      const dotIdx = entry.lastIndexOf('.');
      if (dotIdx >= 0 && ASSET_EXTENSIONS.has(entry.slice(dotIdx))) {
        out.push(full);
      }
    }
  }
  return out;
}

if (!existsSync(DIST)) {
  console.error(`dist/ does not exist — run \`tsc\` first`);
  process.exit(1);
}

const assets = walk(SRC);
let copied = 0;
for (const src of assets) {
  const rel = relative(SRC, src);
  const dest = join(DIST, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
  copied++;
}
console.log(`copied ${copied} asset files into dist/`);
