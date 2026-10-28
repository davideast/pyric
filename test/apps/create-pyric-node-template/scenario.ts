// The create-pyric node template runs its own dev flow (#1203). The scenario
// scaffolds the template through the packed create-pyric, installs the
// scaffolded project, and runs `npm run dev` as the README's quick start says.
// The template's src/app.ts uses the client `firebase/firestore` SDK in a
// server process: it seeds two posts, reads them with getDocs, and prints
// each with `snap.forEach`.
//
// On main the dev script ran `pyric sandbox --no-open -- node ...`, and the
// first Firestore call failed: client SDKs in a server process reach only the
// Node host. With `--hosted`, the served client's QuerySnapshot had no
// `forEach`, so the template crashed on its last line.
//
// Running dev a second time checks that the seed is idempotent: the hosted
// sandbox keeps its data between runs, and the template still prints 2 posts.
import assert from 'node:assert/strict';
import { scenario, type App, type ScriptResult } from '../driver.ts';

const PROJECT = 'my-node-app';

async function runDev(app: App): Promise<ScriptResult> {
  const result = await app.command('npm', ['run', 'dev'], { cwd: PROJECT, timeoutMs: 120_000 });
  assert.doesNotMatch(result.output, /reach only the Node host/, 'the dev script ran the client SDKs off the Node host');
  assert.doesNotMatch(result.output, /forEach is not a function/, 'the query snapshot has no forEach');
  assert.equal(result.code, 0, `npm run dev exited with code ${result.code}`);
  return result;
}

/** The post lines src/app.ts prints: `2 posts:` then one `  <id>: {...}` line per post. */
function printedPosts(output: string): { count: number; ids: string[] } {
  const count = Number(output.match(/(\d+) posts:/)?.[1]);
  const ids = [...output.matchAll(/^\S*\s+([\w-]+): \{/gm)].map((line) => line[1]!).sort();
  return { count, ids };
}

export default scenario(async (app) => {
  await app.step('create-pyric scaffolds the node template', async () => {
    const result = await app.command('node', ['node_modules/create-pyric/dist/bin.js', PROJECT, '--template', 'node']);
    assert.equal(result.code, 0, result.output);
    const manifest = JSON.parse(app.readFile(`${PROJECT}/package.json`)) as { scripts: Record<string, string> };
    assert.match(manifest.scripts.dev ?? '', /^pyric sandbox /);
  });

  await app.step('install the scaffolded project', () => app.installProject(PROJECT));

  // The scaffold pins firebase to the certified minor line (#1188). A caret
  // range installed a newer minor, whose exports pyric may not mirror.
  await app.step('the scaffolded project installs firebase on the minor line its package.json names', () => {
    const manifest = JSON.parse(app.readFile(`${PROJECT}/package.json`)) as { dependencies: Record<string, string> };
    const named = manifest.dependencies.firebase?.match(/(\d+)\.(\d+)\.\d+/);
    assert.ok(named, `the scaffold names no firebase version: ${manifest.dependencies.firebase}`);
    const installed = JSON.parse(app.readFile(`${PROJECT}/node_modules/firebase/package.json`)) as { version: string };
    assert.equal(installed.version.split('.').slice(0, 2).join('.'), `${named[1]}.${named[2]}`,
      `firebase ${manifest.dependencies.firebase} installed ${installed.version}`);
  });

  await app.step('npm run dev seeds the sandbox and prints both posts', async () => {
    const { output } = await runDev(app);
    assert.deepEqual(printedPosts(output), { count: 2, ids: ['hello', 'local-first'] }, output);
  });

  await app.step('a second npm run dev prints the same two posts', async () => {
    const { output } = await runDev(app);
    assert.deepEqual(printedPosts(output), { count: 2, ids: ['hello', 'local-first'] }, output);
  });
});
