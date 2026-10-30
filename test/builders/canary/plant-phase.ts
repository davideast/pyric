/**
 * The canary's plant phase. `canary.ts` runs it inside the run's sandbox, so
 * it and everything it starts see only the allowlisted files and loopback:
 *
 *   nsenter -t <pid> -U -m -n -p -i -u -C --preserve-credentials --root env -C <repo> bun plant-phase.ts <run dir>
 *
 * Before anything else it runs the sandbox inventory itself, so a caller that
 * skips the sandbox fails before any plant runs. Then it starts the harness
 * browser, the app's Vite dev server and the plant scripts, and writes what
 * each plant saw to `<run dir>/plants.json`.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser } from '@playwright/test';
import { AppRun } from '../../apps/driver.ts';
import { BROWSER_WS_ENV, startBrowserServer, type BrowserServer } from '../browser-server.ts';
import { assertInsideSandbox, inventoryLine } from '../sandbox-check.ts';
import { recorderEnvironment, runDirsAt, type RunDirs } from '../scratch.ts';
import type { CanaryObservations } from './verdict.ts';

const BROWSER_PLANTS = fileURLToPath(new URL('./browser-plants.ts', import.meta.url));
const PLANTS_TIMEOUT_MS = 120_000;
const UNHOOKED_TIMEOUT_MS = 30_000;

export const PLANTS_FILE = 'plants.json';

export type PlantOutput = Omit<CanaryObservations, 'record'>;

function step(line: string): void {
  console.log(`▸ ${line}`);
}

/** The JSON line a plant script printed last. */
function lastJsonLine<T>(output: string, what: string): T {
  const line = output.split('\n').reverse().find((text) => text.startsWith('{"'));
  if (line === undefined) throw new Error(`${what} printed no result:\n${output}`);
  return JSON.parse(line) as T;
}

/** The canary drives Chromium through the harness browser server, never AppRun's own browser. */
const noDriverBrowser = (): Promise<Browser> => Promise.reject(new Error('the canary uses the harness browser server'));

function saveProcessLogs(app: AppRun, dirs: RunDirs): void {
  for (const [index, child] of app.processes.entries()) {
    const name = `${String(index + 1).padStart(2, '0')}-${child.name.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-|-$/g, '')}`;
    writeFileSync(join(dirs.logs, `${name.slice(0, 100)}.log`), child.header + child.output);
  }
}

/**
 * Requests from clients no recorder hooks. Only the sandbox stops them: its
 * resolver records their lookups, and its catch-all listener records a
 * connection by address.
 */
function unhookedPlants(bun: string): { name: string; host: string; command: string; args: string[] }[] {
  const bunFetch = (url: string) => [
    '-e',
    `await fetch(${JSON.stringify(url)}, { signal: AbortSignal.timeout(10_000) }).then(() => console.log('succeeded'), (error) => { console.log('failed: ' + (error.code ?? error.message)); });`,
  ];
  return [
    { name: 'Bun fetch to a Google host the catalog does not list', host: 'oauth2.googleapis.com', command: bun, args: bunFetch('https://oauth2.googleapis.com/token') },
    { name: 'Bun fetch to the metadata server by address', host: '169.254.169.254', command: bun, args: bunFetch('http://169.254.169.254/computeMetadata/v1/') },
    { name: 'curl to Firebase Installations', host: 'firebaseinstallations.googleapis.com', command: 'curl', args: ['-sS', '--max-time', '10', '-o', '/dev/null', 'https://firebaseinstallations.googleapis.com/v1/projects/demo-canary/installations'] },
  ];
}

/** `succeeded` when the client said so or exited 0 without saying, else `failed: <its last line>`. */
function unhookedOutcome(code: number | null, output: string): string {
  const last = output.trim().split('\n').at(-1) ?? '';
  if (last === 'succeeded') return last;
  if (last.startsWith('failed')) return last;
  return code === 0 ? 'succeeded' : `failed: exit ${code}: ${last}`;
}

async function plant(app: AppRun, recorded: Record<string, string>, browser: BrowserServer): Promise<PlantOutput> {
  step('starting the Vite dev server, under the recorder');
  const host = await app.devServer({ env: recorded });

  step('node plants: node --import @pyric/cli/register node-plants.mjs');
  const nodeRun = await app.serverScript('node-plants.mjs', [], {
    env: { ...recorded, PYRIC_SANDBOX: `remote:${host.url}`, CANARY_LOCAL_URL: `${host.url}/local.txt` },
    timeoutMs: PLANTS_TIMEOUT_MS,
  });
  const node = lastJsonLine<PlantOutput['node']>(nodeRun.output, 'node-plants.mjs');

  step('browser plants: node browser-plants.ts, connected to the harness browser');
  const browserRun = await app.command('node', [BROWSER_PLANTS], {
    env: { ...recorded, [BROWSER_WS_ENV]: browser.wsEndpoint, CANARY_APP_URL: host.url },
    timeoutMs: PLANTS_TIMEOUT_MS,
  });
  const browserResult = lastJsonLine<PlantOutput['browser'] & { preflight: unknown }>(browserRun.output, 'browser-plants.ts');
  if (browserRun.code !== 0) {
    throw new Error(`browser-plants.ts exited ${browserRun.code}; preflight ${JSON.stringify(browserResult.preflight)}:\n${browserRun.output}`);
  }

  step('unhooked plants: Bun and curl, which only the sandbox stops');
  const unhooked = [];
  for (const planted of unhookedPlants(process.execPath)) {
    const result = await app.command(planted.command, planted.args, { env: recorded, timeoutMs: UNHOOKED_TIMEOUT_MS });
    unhooked.push({ name: planted.name, host: planted.host, outcome: unhookedOutcome(result.code, result.output) });
  }
  return { node, browser: browserResult, unhooked: { plants: unhooked } };
}

async function main(root: string): Promise<void> {
  step(inventoryLine(assertInsideSandbox(root, 'plant')));
  const dirs = runDirsAt(root);
  const recorded = recorderEnvironment(dirs.networkLog);
  const app = new AppRun('builders-canary', dirs.app, dirs.home, noDriverBrowser);
  let browser: BrowserServer | undefined;
  try {
    step('starting the harness browser');
    browser = await startBrowserServer({ netLogPath: dirs.netLog, networkLog: dirs.networkLog, home: dirs.home });
    const output = await plant(app, recorded, browser);
    writeFileSync(join(dirs.root, PLANTS_FILE), `${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await browser?.stop();
    await app.close();
    saveProcessLogs(app, dirs);
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) throw new Error('usage: bun test/builders/canary/plant-phase.ts <run dir>');
  await main(root);
}
