/**
 * The one command that starts Studio from a checkout, inside a sandbox:
 *
 *   pyric sandbox --hosted --no-open --host 127.0.0.1 --port 3473 -- next dev --port 3000
 *
 * from `studio/`, as Studio's own `dev` script runs it, with a fake Firebase
 * web config, the run's ffmpeg when there is one, and no secret: no Gemini
 * or ElevenLabs key, no service account.
 * The sandbox's network is loopback alone, so no Google host is reachable,
 * and each sandbox has its own loopback, so every checkout uses Studio's
 * usual ports without meeting another's. It resolves once Studio answers.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import type { EgressNamespace } from '../namespace.ts';
import { demoProjectId, fakeFirebaseConfig } from '../scratch.ts';
import type { Checkout } from './app-paths.ts';
import { Aborted, baseEnvironment, sandboxRunner, trackGroup } from './exec.ts';
import { ffmpegEnvironment } from './tools.ts';

export const APP_PORT = 3000;
export const PYRIC_PORT = 3473;
/** The brief's fake media provider, inert until the app has it. Without it, walks and the user agent can't reach a generated item. */
export const FAKE_MEDIA = { MDMEDIA_FAKE_MEDIA: '1' };
const READY_TIMEOUT_MS = 6 * 60_000;
const STOP_GRACE_MS = 10_000;

export interface StartOptions {
  checkout: Checkout;
  namespace: EgressNamespace;
  /** Where Studio's output goes. */
  logFile: string;
  /** A public host name Pyric and Next must accept, such as the tailnet's. */
  allowedHost?: string;
  /** The port a remote page dials for Pyric's WebSocket, when it isn't 3473. */
  publicBridgePort?: number;
  /** The run's ffmpeg, checked by hash, for Studio's media routes. */
  ffmpeg?: string;
  /** Stops Studio when it aborts. */
  signal?: AbortSignal;
}

export interface StartedApp {
  /** Studio's address inside the sandbox. */
  url: string;
  stop(): Promise<void>;
}

/** Studio's environment: the base one, a fake web config for a `demo-` project, and the public host and the run's ffmpeg when there are. */
export function studioEnvironment(options: Pick<StartOptions, 'checkout' | 'allowedHost' | 'publicBridgePort' | 'ffmpeg'>): Record<string, string> {
  const projectId = demoProjectId('mdmedia-studio');
  const config = fakeFirebaseConfig(projectId);
  const env: Record<string, string> = {
    ...baseEnvironment(options.checkout.home),
    NEXT_PUBLIC_FIREBASE_API_KEY: config.apiKey ?? '',
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: config.authDomain ?? '',
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: projectId,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: config.storageBucket ?? '',
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: '000000000000',
    NEXT_PUBLIC_FIREBASE_APP_ID: config.appId ?? '',
    FIREBASE_PROJECT_ID: projectId,
    FIREBASE_STORAGE_BUCKET: config.storageBucket ?? '',
    PORT: String(APP_PORT),
    ...FAKE_MEDIA,
    ...ffmpegEnvironment(options.ffmpeg),
  };
  if (options.allowedHost !== undefined) env.MDMEDIA_ALLOWED_DEV_ORIGINS = options.allowedHost;
  if (options.publicBridgePort !== undefined) env.NEXT_PUBLIC_PYRIC_BRIDGE_PORT = String(options.publicBridgePort);
  return env;
}

/** The start command's arguments for `node`, run in `studio/`. */
export function studioArgs(allowedHost?: string): string[] {
  const allowed = allowedHost === undefined ? [] : ['--allowed-host', allowedHost];
  return [
    'node_modules/@pyric/cli/dist/cli/index.js', 'sandbox', '--hosted', '--no-open', '--host', '127.0.0.1', '--port', String(PYRIC_PORT), ...allowed,
    '--', 'node', 'node_modules/next/dist/bin/next', 'dev', '--port', String(APP_PORT), '--hostname', '127.0.0.1',
  ];
}

/** A Node one-liner, run inside the sandbox, that exits 0 once `url` answers below 500. */
export function waitScript(url: string, timeoutMs: number): string {
  return `const end=Date.now()+${timeoutMs};const go=async()=>{for(;;){try{const r=await fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(60000)});if(r.status<500)process.exit(0);}catch{}if(Date.now()>end)process.exit(1);await new Promise(r=>setTimeout(r,2000));}};go();`;
}

function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('exit', (code) => resolve(code)));
}

/** Ends Studio's whole process group: SIGTERM, then SIGKILL after a grace period. */
async function stopGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  const exited = exitOf(child);
  const signal = (name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch { /* already gone */ } };
  signal('SIGTERM');
  const grace = new Promise<'grace'>((resolve) => setTimeout(() => resolve('grace'), STOP_GRACE_MS));
  const ended = await Promise.race([exited.then(() => 'exited' as const), grace]);
  if (ended === 'grace') signal('SIGKILL');
  await exited;
}

export class AppDidNotStart extends Error {}

type StartOutcome = 'ready' | 'silent' | 'exited';

function notStartedReason(outcome: StartOutcome): string {
  if (outcome === 'exited') return 'exited before it answered';
  return `did not answer within ${READY_TIMEOUT_MS / 60_000} minutes`;
}

export async function startApp(options: StartOptions): Promise<StartedApp> {
  const { checkout, namespace } = options;
  mkdirSync(checkout.home, { recursive: true });
  const entered = namespace.enter('node', studioArgs(options.allowedHost), checkout.studio);
  const log = openSync(options.logFile, 'a');
  // Its own process group, which an abort or this process's exit ends (`exec.ts`).
  const child = spawn(entered.command, entered.args, { cwd: '/', env: studioEnvironment(options), stdio: ['ignore', log, log], detached: true });
  trackGroup(child, options.signal);
  closeSync(log);
  const url = `http://127.0.0.1:${APP_PORT}/`;
  const run = sandboxRunner(namespace, checkout.home, options.signal);
  const waited = run({ command: 'node', args: ['-e', waitScript(url, READY_TIMEOUT_MS)], cwd: '/', timeoutMs: READY_TIMEOUT_MS + 60_000 });
  const answered = waited.then((result): StartOutcome => (result.code === 0 ? 'ready' : 'silent'), (): StartOutcome => 'silent');
  const outcome = await Promise.race([answered, exitOf(child).then((): StartOutcome => 'exited')]);
  const app: StartedApp = { url, stop: () => stopGroup(child) };
  if (outcome === 'ready') return app;
  await app.stop();
  if (options.signal?.aborted === true) throw new Aborted('the check was stopped while Studio started');
  throw new AppDidNotStart(`Studio ${notStartedReason(outcome)}; see ${options.logFile}`);
}

/** Where a start's log goes in a check folder. */
export function startLog(dir: string, label: string): string {
  return join(dir, `${label}-studio.log`);
}
