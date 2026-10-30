// The #1625 cases for the Next scenarios: `withPyric` refuses to start the dev
// server when `PYRIC_SANDBOX` is set but `@pyric/cli/register` is not active
// in the process. Before the fix it checked only the variable, kept
// `firebase-admin` external for a register that wasn't there, and route
// handlers loaded the real `firebase-admin`.
//
// Each case starts Next the way the issue did:
//  - `NODE_ENV=production pyric sandbox -- next dev`: the register refuses
//    under NODE_ENV=production, then Next sets NODE_ENV=development;
//  - `pyric sandbox -- npm run dev`, where the package script sets its own
//    NODE_OPTIONS and so drops the register;
//  - `PYRIC_SANDBOX=remote` in `.env`, then plain `next dev`.
//
// The safety preload from `nextjs-firebase-imports.ts` stays in each Next
// process: the package script keeps it in the NODE_OPTIONS it sets.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep, type App } from './driver.ts';

/** What the scenario's safety preload and sink give each case. */
export interface RefusalSafety {
  /** The env every Next process runs with, the safety preload included. */
  env: Record<string, string>;
  /** Connections and real-SDK loads the safety log recorded for this case. */
  escapes(log: string): { realFirebase: string[]; connections: string[] };
}

/** How a started case ended: Next exited, or it served the probe route. */
type Outcome =
  | { kind: 'exited'; code: number | null; output: string }
  | { kind: 'served'; probe: unknown };

interface Started {
  exit: Promise<{ code: number | null; output: string }>;
  stop(): Promise<void>;
}

/** Reports the `firebase-admin/app` a route handler got, and the guard. */
export const PROBE_ROUTE = `import * as admin from 'firebase-admin/app';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    real: !('ADMIN_APP_TARGET' in admin),
    guard: globalThis[Symbol.for('pyric.netGuard')]?.mode ?? null,
  });
}
`;

const REFUSAL = /@pyric\/cli\/register is not active in this process/;

/** The probe route's answer once Next serves it, or null once `done()` says the case ended. */
async function servedProbe(url: string, done: () => boolean): Promise<unknown> {
  const deadline = Date.now() + 180_000;
  while (!done() && Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/probe`, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) return await response.json();
    } catch {
      // not serving yet
    }
    await sleep(500);
  }
  return null;
}

async function outcomeOf(started: Started, url: string): Promise<Outcome> {
  let ended = false;
  const exited = started.exit.then((result) => {
    ended = true;
    return { kind: 'exited' as const, ...result };
  });
  const served = servedProbe(url, () => ended).then((probe) => ({ kind: 'served' as const, probe }));
  const outcome = await Promise.race([exited, served]);
  if (outcome.kind === 'served' && outcome.probe === null) {
    if (!ended) await started.stop();
    return exited;
  }
  if (outcome.kind === 'served') await started.stop();
  return outcome;
}

function fromPyric(app: App, args: string[], env: Record<string, string>): Started {
  const child = app.pyricProcess(args, { env });
  return {
    exit: child.exited.then((code) => ({ code, output: child.output })),
    stop: () => child.stop(),
  };
}

/** `app.command` runs to exit; a Next that serves is stopped by the run's teardown. */
function fromCommand(app: App, command: string, args: string[], env: Record<string, string>): Started {
  const exit = app.command(command, args, { env, timeoutMs: 240_000 });
  exit.catch(() => {});
  return { exit, stop: async () => {} };
}

interface RefusalCase {
  name: string;
  start(app: App, nextArgs: string[], sandboxArgs: string[], env: Record<string, string>): Started;
}

const CASES: readonly RefusalCase[] = [
  {
    name: 'NODE_ENV=production pyric sandbox -- next dev',
    start: (app, nextArgs, sandboxArgs, env) =>
      fromPyric(app, [...sandboxArgs, '--', ...nextArgs], { ...env, NODE_ENV: 'production' }),
  },
  {
    name: 'pyric sandbox -- npm run dev, a script that sets NODE_OPTIONS',
    start: (app, nextArgs, sandboxArgs, env) => {
      const manifest = JSON.parse(readFileSync(join(app.dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      const dev = `NODE_OPTIONS="${env.NODE_OPTIONS} --max-old-space-size=4096" ${nextArgs.join(' ')}`;
      app.writeFile('package.json', JSON.stringify({ ...manifest, scripts: { dev } }, null, 2));
      return fromPyric(app, [...sandboxArgs, '--', 'npm', 'run', 'dev'], { ...env, npm_config_update_notifier: 'false' });
    },
  },
  {
    // Last: the .env file stays in the app directory.
    name: 'PYRIC_SANDBOX=remote in .env, then next dev',
    start: (app, nextArgs, _sandboxArgs, env) => {
      app.writeFile('.env', 'PYRIC_SANDBOX=remote\n');
      return fromCommand(app, nextArgs[0]!, nextArgs.slice(1), env);
    },
  },
];

/** Runs each refusal case in turn. */
export async function runRefusals(app: App, safety: RefusalSafety): Promise<void> {
  for (const refusal of CASES) {
    await app.step(`${refusal.name}: withPyric refuses to start without the register`, async () => {
      const sandboxPort = await app.freePort();
      const nextPort = await app.freePort();
      const log = join(app.dir, '..', `safety-refusal-${sandboxPort}.log`);
      const env = { ...safety.env, SCENARIO_SAFETY_LOG: log };
      const sandboxArgs = ['sandbox', '--no-open', '--port', String(sandboxPort)];
      const nextArgs = ['next', 'dev', '--port', String(nextPort), '--hostname', '127.0.0.1'];
      const outcome = await outcomeOf(refusal.start(app, nextArgs, sandboxArgs, env), `http://127.0.0.1:${nextPort}`);
      assert.equal(outcome.kind, 'exited', `Next served the app without the register: /api/probe answered ${JSON.stringify(outcome.kind === 'served' ? outcome.probe : null)}`);
      if (outcome.kind !== 'exited') return;
      assert.notEqual(outcome.code, 0, outcome.output);
      assert.match(outcome.output, REFUSAL);
      assert.deepEqual(safety.escapes(log), { realFirebase: [], connections: [] });
    });
  }
}
