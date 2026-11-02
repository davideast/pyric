// `pyric sandbox --hosted` serves no project state over HTTP (#1779). A
// project whose firebase.json had no `hosting` block was served from its own
// directory, which holds `.pyric/state/hosted/state.sqlite` (users and data),
// `.env`, `.firebaserc` and `node_modules`. Anyone who could reach the port
// downloaded the database. Production has no Hosting site without a
// `hosting` block, so pyric now serves no static files then, and says so at
// startup. With `"public": "."`, production Hosting still never serves those
// paths: the `ignore` list `firebase init` writes leaves out `firebase.json`,
// every dot file, and `node_modules`. The host answers 404 for each of them,
// including percent-encoded, doubled-slash and dot-segment spellings and a
// symlink that points into `.pyric/`, and still serves the page. The Vite
// plugin's hosted dev server, which serves its root the way Vite does,
// refuses `.pyric/` by path, by query suffix and through `/@fs`.
import assert from 'node:assert/strict';
import { existsSync, realpathSync, symlinkSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { scenario, sleep, type App, type AppProcess } from '../driver.ts';

const STATE_FILE = '.pyric/state/hosted/state.sqlite';
const SECRET = 'PYRIC_SCENARIO_SECRET=do-not-serve';

/** Request targets sent as written, so no client normalizes them first. */
const REFUSED = [
  `/${STATE_FILE}`,
  `/%2epyric/state/hosted/state.sqlite`,
  `/%2Epyric/state/hosted/state.sqlite`,
  `//${STATE_FILE}`,
  `/assets/..%2f.pyric/state/hosted/state.sqlite`,
  `/assets/%2e%2e/.pyric/state/hosted/state.sqlite`,
  `/.pyric/state/hosted/`,
  '/.env',
  '/.firebaserc',
  '/firebase.json',
  '/node_modules/@pyric/cli/package.json',
  '/node%5fmodules/@pyric/cli/package.json',
];

interface Answer {
  status: number;
  body: string;
}

function rawGet(port: number, target: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: target, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('latin1');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function waitForHost(port: number, host: AppProcess): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    assert.ok(host.running, 'pyric sandbox exited before it served /__pyric/health');
    try {
      if ((await rawGet(port, '/__pyric/health')).status === 200) return;
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < deadline, `pyric sandbox did not answer /__pyric/health on port ${port} within 90s`);
    await sleep(250);
  }
}

async function waitForStateFile(app: App): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(app.dir, STATE_FILE))) {
    assert.ok(Date.now() < deadline, `pyric sandbox --hosted wrote no ${STATE_FILE} within 30s`);
    await sleep(250);
  }
}

async function startHosted(app: App): Promise<{ port: number; host: AppProcess }> {
  const port = await app.freePort();
  const host = app.pyricProcess(['sandbox', '--hosted', '--no-open', '--host', '127.0.0.1', '--port', String(port)]);
  await waitForHost(port, host);
  await waitForStateFile(app);
  return { port, host };
}

async function assertRefusesProjectState(port: number): Promise<void> {
  const served: string[] = [];
  for (const target of REFUSED) {
    const answer = await rawGet(port, target);
    const leaked = answer.body.includes('SQLite format 3') || answer.body.includes(SECRET) || answer.body.includes('"projects"');
    if (answer.status !== 404 || leaked) served.push(`${answer.status} ${target}`);
  }
  assert.deepEqual(served, [], `pyric sandbox --hosted served project state:\n${served.join('\n')}`);
}

export default scenario(async (app) => {
  app.writeFile('.env', `${SECRET}\n`);

  const bare = await app.step('pyric sandbox --hosted starts on a project with no hosting block', () => startHosted(app));

  await app.step('it says hosting is off and serves no static files', async () => {
    await bare.host.waitForLog(/hosting {2}Off: firebase\.json has no hosting block\. Add hosting\.public to serve a site\./);
    assert.equal((await rawGet(bare.port, '/index.html')).status, 404);
  });

  await app.step('it answers 404 for .pyric state, dot files, firebase.json and node_modules', () =>
    assertRefusesProjectState(bare.port));

  await app.step('pyric sandbox stops', () => bare.host.stop());

  // A link a project might keep in its public directory, pointing into state.
  symlinkSync(join(app.dir, '.pyric', 'state'), join(app.dir, 'data'));
  app.writeFile('firebase.json', JSON.stringify({
    firestore: { rules: 'firestore.rules' },
    hosting: { public: '.', ignore: ['firebase.json', '**/.*', '**/node_modules/**'] },
  }));

  const rooted = await app.step('pyric sandbox --hosted starts with "public": "."', () => startHosted(app));

  await app.step('it still answers 404 for every ignored path', () => assertRefusesProjectState(rooted.port));

  await app.step('it answers 404 for state reached through a symlink in the public directory', async () => {
    const answer = await rawGet(rooted.port, '/data/hosted/state.sqlite');
    assert.equal(answer.status, 404);
    assert.ok(!answer.body.includes('SQLite format 3'), 'the symlink served the state database');
  });

  await app.step('it serves the page the project deploys', async () => {
    const page = await rawGet(rooted.port, '/index.html');
    assert.equal(page.status, 200);
    assert.match(page.body, /The page this project deploys/);
  });

  await app.step('pyric sandbox stops again', () => rooted.host.stop());

  const vite = await app.step('the Vite plugin\'s hosted dev server serves the project', () => app.devServer());

  await app.step('the Vite dev server refuses .pyric state, by path, by query suffix and through /@fs', async () => {
    const projectDir = realpathSync(app.dir);
    const serveJson = app.readFile('.pyric/serve.json').trim();
    const targets = [
      `/${STATE_FILE}`,
      `/%2epyric/state/hosted/state.sqlite`,
      `/${STATE_FILE}?raw`,
      `/${STATE_FILE}?import`,
      `/${STATE_FILE}?url`,
      `/${STATE_FILE}?inline`,
      '/.pyric/serve.json',
      '/.pyric/serve.json?import',
      '/.pyric/serve.json?url',
      '/.pyric/serve.json?inline',
      `/@fs${projectDir}/${STATE_FILE}`,
      `/@fs${projectDir}/.pyric/serve.json?import`,
    ];
    const served: string[] = [];
    for (const target of targets) {
      const answer = await rawGet(vite.port, target);
      const refused = answer.status === 403 || answer.status === 404;
      const leaked = answer.body.includes('SQLite format 3') || answer.body.includes(serveJson);
      if (!refused || leaked) served.push(`${answer.status} ${target}: ${JSON.stringify(answer.body.slice(0, 160))}`);
    }
    assert.deepEqual(served, [], `the Vite dev server served .pyric state:\n${served.join('\n')}`);
  });
});
