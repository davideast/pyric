/**
 * Generate the non-authored docs pages into src/content/_generated/ right
 * before `astro build`. Two producers, one gitignored directory:
 *
 *   1. The conformance matrices (loadConformancePages + transformCompatTables),
 *      written under their stable flat slug filenames so their public URLs
 *      (/docs/firestore-compat/ …) stay stable.
 *   2. The generated API reference (scripts/gen-api-docs.ts --write), which
 *      writes its own flat-slug files into the same directory.
 *
 * The whole directory is cleared first so nothing stale survives. Authored
 * content is never touched.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConformancePages } from './conformance-pages';
import { transformCompatTables } from './compat-tables';
import { titleOf } from '../src/lib/markdown-structure';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const repoRoot = resolve(siteRoot, '..', '..');
const outDir = join(siteRoot, 'src', 'content', '_generated');

/** Flat slug for a virtual conformance source, matching
 *  docs-routes.compatibilitySlug (prefix-free: ai-compat, functions-rtdb-compat,
 *  conformance-scores). */
function conformanceSlug(path: string): string {
  const rel = path
    .replace(/^packages\/pyric\/docs\//, '')
    .replace(/^packages\/cli\/docs\//, '')
    .replace(/\.md$/, '');
  const segs = rel.split('/');
  if (segs[segs.length - 1] === 'README') segs.pop();
  return segs.join('-').toLowerCase();
}

function yamlQuote(s: string): string {
  return JSON.stringify(s);
}

/** The scoreboard's cross-links to compat pages and its "how we know" link are
 *  emitted as directory URLs by the generator; the only .md-relative link is
 *  the per-page scoreboard link, rewritten here to the scoreboard's route. */
function rewriteConformanceLinks(body: string): string {
  return body.replace(
    /\]\((?:\.\.\/)*[\w./-]*conformance\/SCORES\.md\)/g,
    '](../conformance-scores/)',
  );
}

async function writeConformancePages(): Promise<number> {
  const pages = await loadConformancePages(repoRoot);
  const catalogSlug = (src: string): string => {
    // src is resolve(repoRoot, path); recover the repo-relative virtual path.
    const rel = src.slice(repoRoot.length + 1).replaceAll('\\', '/');
    return conformanceSlug(rel);
  };
  let order = 0;
  for (const page of pages) {
    order += 10;
    const slug = catalogSlug(page.src);
    const body = transformCompatTables(rewriteConformanceLinks(page.rendered));
    const title = titleOf(page.src, () => page.rendered);
    const fm = [
      '---',
      `title: ${yamlQuote(title)}`,
      ...(page.label && page.label !== title ? [`navLabel: ${yamlQuote(page.label)}`] : []),
      'group: "Conformance"',
      'section: ""',
      `order: ${order}`,
      '---',
      '',
    ].join('\n');
    writeFileSync(join(outDir, `${slug}.md`), fm + body);
  }
  return pages.length;
}

async function main() {
  // Preflight: both producers need built package dists — the API reference
  // reads every manifest's `types` target, and the conformance projection is
  // shipped inside @pyric/cli's dist. Fail with the fix, not a module error.
  const cliConformanceDist = join(repoRoot, 'packages', 'cli', 'dist', 'conformance', 'index.js');
  if (!existsSync(cliConformanceDist)) {
    console.error(
      'generate-content: packages are not built (missing packages/cli/dist/conformance).\n' +
        'Build packages first, from the repo root:\n\n' +
        '  bun run build --packages-only\n',
    );
    process.exit(1);
  }

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const conformanceCount = await writeConformancePages();
  console.log(`generated ${conformanceCount} conformance pages`);

  // The API reference generator owns its own flat-slug files in the same dir.
  execFileSync('bun', ['run', join(repoRoot, 'scripts', 'gen-api-docs.ts'), '--write'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

await main();
