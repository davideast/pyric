// Writes the conformance pages the installed `@pyric/cli` ships
// (`@pyric/cli/conformance/docs`, the same pages the site renders) as
// Markdown files, so a builder reads them from the tarballs it builds with.
// Run inside the run's sandbox, after the install:
//
//   node test/builders/docs-export.mjs <app dir> <out dir>
//
// The page module is found through the installed package's own `exports`,
// so the repo's workspace copy is never read by mistake.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [appDir, outDir] = process.argv.slice(2);
if (appDir === undefined || outDir === undefined) throw new Error('usage: node docs-export.mjs <app dir> <out dir>');

const packageDir = join(appDir, 'node_modules', '@pyric', 'cli');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const entry = manifest.exports?.['./conformance/docs']?.import;
if (typeof entry !== 'string') throw new Error(`${packageDir} exports no ./conformance/docs`);

const { CONFORMANCE_DOCS_PAGES: pages } = await import(pathToFileURL(join(packageDir, entry)).href);
for (const page of pages) {
  const file = join(outDir, `${page.slug}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page.markdown);
}
console.log(JSON.stringify({ pages: pages.length }));
