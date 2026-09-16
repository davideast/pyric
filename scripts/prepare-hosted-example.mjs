/** Prepare a disposable CLI-hosted example, keeping Firebase imports for the host's import map. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { basename, join, sep } from 'node:path';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../packages/cli/package.json', import.meta.url));
const { build } = require('esbuild');
const root = fileURLToPath(new URL('..', import.meta.url));
const name = process.argv[2];
const entries = { 'teams-workspace': 'app.ts', 'vite-sandbox-app': 'src/main.ts', 'ai-chat': null };
const isKnownExample = Object.hasOwn(entries, name);
if (!isKnownExample) throw new Error('Choose teams-workspace, vite-sandbox-app, or ai-chat.');
const source = `${root}/examples/${name}`;
const project = await mkdtemp(join(tmpdir(), `pyric-local-qa-${name}-`));
await cp(source, project, {
  recursive: true,
  filter(path) {
    const excludedDirectory = path
      .split(sep)
      .some((part) => ['node_modules', '.pyric', 'dist'].includes(part));
    const environmentFile = basename(path).startsWith('.env');
    const shouldCopy = !excludedDirectory && !environmentFile;
    return shouldCopy;
  },
});
const configPath = `${project}/firebase.json`;
const config = JSON.parse(await readFile(configPath, 'utf8'));
config.hosting = { ...config.hosting, public: '.' };
await writeFile(configPath, JSON.stringify(config, null, 2));
const entry = entries[name];
if (entry) {
  await build({
    entryPoints: [`${source}/${entry}`],
    outfile: `${project}/checkpoint.js`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    external: ['firebase/*'],
    nodePaths: [`${root}/packages/studio/node_modules`],
    define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"development"' },
  });
  const html = await readFile(`${project}/index.html`, 'utf8');
  await writeFile(`${project}/index.html`, html.replace(`/${entry}`, '/checkpoint.js'));
}
console.log(project);
