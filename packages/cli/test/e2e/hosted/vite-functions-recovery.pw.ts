import { expect, test } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { pyric } from '../../../dist/vite.js';

const cliDir = fileURLToPath(new URL('../../../', import.meta.url));
const firebaseFunctions = fileURLToPath(new URL('../../../../conformance/node_modules/firebase-functions', import.meta.url));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('SharedWorker Functions recovers when the last browser closes during startup', async ({ browser }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-functions-recovery-')));
  const started = join(root, 'started');
  const release = join(root, 'release');
  let server: ViteDevServer | undefined;
  let context = await browser.newContext();
  const messages: string[] = [];
  const pids = () => {
    const hasStarted = existsSync(started);
    return hasStarted ? readFileSync(started, 'utf8').trim().split('\n').map(Number) : [];
  };
  try {
    mkdirSync(join(root, 'node_modules/@pyric'), { recursive: true });
    symlinkSync(cliDir, join(root, 'node_modules/@pyric/cli'));
    mkdirSync(join(root, 'functions/node_modules'), { recursive: true });
    symlinkSync(firebaseFunctions, join(root, 'functions/node_modules/firebase-functions'));
    writeFileSync(join(root, 'firebase.json'), JSON.stringify({ functions: { source: 'functions' }, database: { rules: 'database.rules.json' } }));
    writeFileSync(join(root, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
    writeFileSync(join(root, 'functions/package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
    writeFileSync(join(root, 'functions/index.js'), `
      import { onValueCreated } from 'firebase-functions/v2/database';
      import { appendFileSync, existsSync } from 'node:fs';
      appendFileSync(${JSON.stringify(started)}, process.pid + '\\n');
      while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 20));
      export const upper = onValueCreated('/input/{id}', event => event.data.ref.root.child('output').set(event.data.val().toUpperCase()));
    `);
    writeFileSync(join(root, 'index.html'), '<html><head></head><body><output id="status">Starting</output><output id="result"></output><button>Write</button><script type="module" src="/main.js"></script></body></html>');
    writeFileSync(join(root, 'main.js'), `
      import { initializeApp } from 'firebase/app';
      import { getDatabase, ref, set, onValue } from 'firebase/database';
      const db = getDatabase(initializeApp({ apiKey: 'demo', projectId: 'functions-recovery', databaseURL: 'https://functions-recovery-default-rtdb.firebaseio.com' }));
      onValue(ref(db, 'output'), snapshot => document.querySelector('#result').textContent = snapshot.val() ?? '');
      document.querySelector('button').onclick = () => set(ref(db, 'input/test'), 'hello');
      document.querySelector('#status').textContent = 'Ready';
    `);
    const log = (message: string) => { messages.push(message); };
    server = await createServer({
      root, configFile: false,
      customLogger: { info: log, warn: log, warnOnce: log, error: log, clearScreen() {}, hasErrorLogged: () => false, hasWarned: false },
      plugins: [pyric({ hosted: false, bridge: true, persist: false, capture: false, ui: false, functions: { watch: false } })],
      server: { host: '127.0.0.1', port: 0, fs: { allow: [root, cliDir] } },
    });
    await server.listen();
    const url = server.resolvedUrls?.local[0];
    const missingUrl = url === undefined;
    if (missingUrl) throw new Error('Vite did not publish a local URL');
    const first = await context.newPage();
    await first.goto(url);
    await expect(first.locator('#status')).toHaveText('Ready');
    await expect.poll(pids).toHaveLength(1);
    await context.close();
    writeFileSync(release, 'resume');
    await expect.poll(() => messages.join('\n')).toContain('functions failed to start');
    await expect.poll(() => pids().some(alive)).toBe(false);
    context = await browser.newContext();
    const reopened = await context.newPage();
    await reopened.goto(url);
    await expect.poll(() => messages.join('\n')).toContain('functions 1 onValueCreated trigger');
    await reopened.getByRole('button', { name: 'Write' }).click();
    await expect(reopened.locator('#result')).toHaveText('HELLO');
    expect(pids()).toHaveLength(2);
    const executions = () => messages.filter(message => message.includes('function upper ← /input/test'));
    await expect.poll(executions).toHaveLength(1);
  } finally {
    await context.close();
    await server?.close();
    await expect.poll(() => pids().some(alive)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  }
});
