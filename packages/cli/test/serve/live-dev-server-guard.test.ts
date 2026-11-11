/**
 * A live dev server process reaches no production project on pyric's behalf,
 * and installs no socket/network interception (ADR 0022, ADR 0023). A real
 * Node process starts Vite with `pyricLive()`, then:
 *
 * - opens a connection to Google's token endpoint, as app code in the dev
 *   server could, which goes out unimpeded (to a closed loopback port, by its
 *   own lookup, to a port bound and closed for it);
 * - sends `storage.provision` and `assurance.testRulesHosted` with
 *   `allowProduction` and `confirm: true` to the hosted method route, as
 *   `pyric storage provision --allow-production` does, and `storage.status`
 *   and `auth.impersonate`; the live host refuses each with
 *   `PYRIC_LIVE_REFUSED` before its handler runs.
 *
 * Runs under the `node` on PATH. Requires the CLI and `@pyric/live` to be
 * built (`dist/`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { closedPort } from '../closed-port.js';

const cliDir = resolve(import.meta.dir, '../..');
const repoRoot = resolve(cliDir, '../..');
const liveDir = join(repoRoot, 'packages/live');
const requireFromCli = createRequire(join(cliDir, 'package.json'));
const viteDir = realpathSync(dirname(requireFromCli.resolve('vite/package.json')));
const realFirebaseDir = realpathSync(dirname(createRequire(join(repoRoot, 'package.json')).resolve('firebase/package.json')));

const SCENARIO = `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'vite';
const root = process.cwd();
const { pyricLive } = await import(pathToFileURL(createRequire(join(root, 'package.json')).resolve('@pyric/live/vite')).href);
const server = await createServer({
  root, configFile: false, logLevel: 'silent',
  plugins: [pyricLive({ capture: false, ui: false })],
  server: { host: '127.0.0.1', port: 0 },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\\/$/, '');
const { token: sessionToken } = JSON.parse(readFileSync(join(root, '.pyric/serve.json'), 'utf8'));
const outcome = {};
// Google's token host, resolved to a closed loopback port: the connection goes out, and nothing reaches Google.
const toLoopback = (_host, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  if (typeof options === 'object' && options?.all === true) done(null, [{ address: '127.0.0.1', family: 4 }]);
  else done(null, '127.0.0.1', 4);
};
outcome.token = await new Promise((resolve) => {
  try {
    const socket = net.connect({ host: 'oauth2.googleapis.com', port: Number(process.env.CLOSED_PORT), lookup: toLoopback });
    socket.on('connect', () => { socket.destroy(); resolve('connected'); });
    socket.on('error', (error) => resolve(error.code ?? String(error)));
  } catch (error) {
    resolve(error.code ?? String(error));
  }
});
const health = await (await fetch(base + '/__pyric/health', {
  headers: { 'x-pyric-session-token': sessionToken },
})).json();
outcome.hasSocketUnobserved = 'unobserved' in (health.live ?? {});
const method = async (key, args, allowProduction) => {
  const response = await fetch(base + '/__pyric/hosted/method', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pyric-session-token': sessionToken },
    body: JSON.stringify({ instanceId: health.instanceId, projectDir: root, key, args, allowProduction }),
  });
  const result = await response.json();
  return (result.data?.code ?? 'no-code') + ': ' + result.summary;
};
outcome.provision = await method('storage.provision', { bucket: 'demo.firebasestorage.app', confirm: true }, true);
outcome.testRulesHosted = await method('assurance.testRulesHosted', {
  service: 'firestore', rules: "rules_version = '2';\\nservice cloud.firestore {}",
  cases: [{ description: 'owner reads', expectation: 'ALLOW', method: 'get', path: 'orders/o1' }], confirm: true,
}, true);
outcome.status = await method('storage.status', { confirm: true }, true);
outcome.impersonate = await method('auth.impersonate', { uid: 'alice' }, false);
await server.close();
console.log('OUTCOME ' + JSON.stringify(outcome));
process.exit(0);
`;

let projectDir: string;
let refusingPort: number;

beforeAll(async () => {
  refusingPort = await closedPort();
  for (const built of [join(cliDir, 'dist/serve/vite-supplied-entry.js'), join(liveDir, 'dist/vite.js')]) {
    if (!existsSync(built)) throw new Error(`${built} missing: build @pyric/cli and @pyric/live first`);
  }
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-live-guard-')));
  mkdirSync(join(projectDir, 'node_modules/@pyric'), { recursive: true });
  symlinkSync(cliDir, join(projectDir, 'node_modules/@pyric/cli'));
  // `@pyric/live` as a packed install has it: its exports name the built files,
  // which plain Node loads (the workspace manifest names the TypeScript source).
  const installedLive = join(projectDir, 'node_modules/@pyric/live');
  mkdirSync(installedLive);
  symlinkSync(join(liveDir, 'dist'), join(installedLive, 'dist'));
  writeFileSync(join(installedLive, 'package.json'), JSON.stringify({
    name: '@pyric/live',
    type: 'module',
    exports: { './vite': './dist/vite.js', './page-modules': './dist/page-modules.js' },
  }));
  symlinkSync(realFirebaseDir, join(projectDir, 'node_modules/firebase'));
  symlinkSync(viteDir, join(projectDir, 'node_modules/vite'));
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'live-guard', private: true, type: 'module' }));
  // The Firebase project live mode names; every live start refuses without one.
  writeFileSync(join(projectDir, '.firebaserc'), JSON.stringify({ projects: { default: 'live-guard' } }));
  writeFileSync(join(projectDir, 'index.html'), '<p>live</p>');
  writeFileSync(join(projectDir, 'scenario.mjs'), SCENARIO);
});

afterAll(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

describe('a live dev server process with pyricLive()', () => {
  it('lets a token request out unimpeded and refuses every production command on the host', () => {
    const result = spawnSync('node', ['scenario.mjs'], {
      cwd: projectDir,
      encoding: 'utf8',
      timeout: 60_000,
      // No credential source either, so a regression stops at the credential lookup, not at Google.
      env: {
        ...process.env,
        FIREBASE_SA_BASE64: '',
        GOOGLE_APPLICATION_CREDENTIALS: join(projectDir, 'no-credentials.json'),
        CLOUDSDK_CONFIG: join(projectDir, 'no-gcloud'),
        PYRIC_PROJECT: '',
        CLOSED_PORT: String(refusingPort),
      },
    });
    const line = result.stdout.split('\n').find((entry) => entry.startsWith('OUTCOME '));
    expect(line, `${result.stdout}\n${result.stderr}`).toBeDefined();
    const outcome = JSON.parse((line as string).slice('OUTCOME '.length)) as Record<string, unknown>;
    const refusedCommand = (key: string) =>
      expect.stringContaining(`PYRIC_LIVE_REFUSED: @pyric/live: ${key} from a pyric command is refused in live mode.`);
    expect(outcome).toEqual({
      token: 'ECONNREFUSED',
      hasSocketUnobserved: false,
      provision: refusedCommand('storage.provision'),
      testRulesHosted: refusedCommand('assurance.testRulesHosted'),
      status: refusedCommand('storage.status'),
      impersonate: refusedCommand('auth.impersonate'),
    });
    expect(result.stderr).not.toContain('unobserved call to');
  }, 70_000);
});
