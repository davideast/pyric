/**
 * Serves the newest servable commit until it is stopped, detached from the
 * check that started it:
 *
 *   bun test/builders/factory/served-process.ts --run-dir <dir> --commit <sha> --root <tree> \
 *     --owner-pid <pid> --owner-start <time> [--deadline <iso>] [--port 4120] [--host <address>]
 *
 * `<tree>` is a fresh directory of `<run>.work/` holding the commit's tar
 * (`tree.ts`). In a sandbox rooted there, as the check runs it, it unpacks
 * and installs the commit and starts Studio, with the run's ffmpeg from
 * `FFMPEG_BIN` (`served.ts` checks it by hash), so the served copy reaches
 * no Google host either. The host reaches it through Unix sockets in that
 * sandbox, opened through `/proc/<pid>/root` (`relay.ts`): `--port` carries
 * Studio on `--host` (loopback unless `PYRIC_FACTORY_SERVE_HOST` names an
 * address, `serve-host.ts`), and `--port + 1` Pyric's WebSocket on
 * 127.0.0.1. Only `--port` is published on the private network
 * (`served.ts`). `--port` also answers `/_factory/status` itself
 * (`status-route.ts`): which commit is served, what changed since the one
 * served before it, and which gates it fails, from `last-served.json`.
 *
 * It writes `<run>.host/served.json` (`starting`, then `ready` or `failed`)
 * with its pid and start time, which the harness checks before it signals
 * the pid, and stops Studio and the sandbox on SIGTERM or SIGINT. It also
 * stops when its owner, the process that started it (checked by start
 * time), is gone or the run's deadline passes; then it removes the
 * private-network entries the run added, since no run end will.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { flagValue } from '../cli-args.ts';
import { startTimeOf } from '../namespace.ts';
import { appPaths, checkoutAt, type AppPaths } from './app-paths.ts';
import { APP_PORT, PYRIC_PORT, startApp } from './app-start.ts';
import { optional } from './optional.ts';
import { insideSandbox, relayPortToSocket, startInsideBridge, waitForSocket } from './relay.ts';
import { PROVIDER_BRIDGE_PORT } from './provider-wiring.ts';
import { openSandbox, specAt } from './sandbox.ts';
import { readLastServed } from './last-served.ts';
import { allowedHosts, LOOPBACK } from './serve-host.ts';
import { removeRecordedEntries } from './served-entries.ts';
import { parseOwner, watchOwner, type Owner } from './served-owner.ts';
import { writeJson } from './state-files.ts';
import { installStudio } from './studio-install.ts';
import { STATUS_PATH, statusPage } from './status-page.ts';
import type { StatusRoute } from './status-route.ts';
import { tailnetHost } from './tailnet.ts';
import { unpackTree } from './tree.ts';

export const DEFAULT_SERVED_PORT = 4120;

const USAGE = 'bun served-process.ts --run-dir <dir> --commit <sha> --root <tree> --owner-pid <pid> --owner-start <time> [--deadline <iso>] [--port <n>] [--host <address>] [--provider-socket <path>]';

export const servedStateSchema = z.object({
  pid: z.number().int().positive(),
  /** The process's start time from /proc, so a reused pid never matches. */
  startTime: z.string(),
  runDir: z.string(),
  commit: z.string(),
  port: z.number().int().min(1024).max(65534),
  status: z.enum(['starting', 'ready', 'failed']),
  startedAt: z.string(),
  error: z.string().optional(),
}).strict();

export type ServedState = z.infer<typeof servedStateSchema>;

export function servedStateFile(paths: AppPaths): string {
  return paths.served;
}

/** The private network's host name and the bound address, which Next and Pyric must allow, when there are. */
function allowedHostOption(host: string): { allowedHost?: string } {
  return optional('allowedHost', allowedHosts(tailnetHost(), host));
}

interface Bridge {
  inner: number;
  socket: string;
  offset: number;
  /** Whether this port listens on the served host and answers the status page; the other stays on loopback. */
  isPublic: boolean;
}

const BRIDGES: readonly Bridge[] = [
  { inner: APP_PORT, socket: 'app.sock', offset: 0, isPublic: true },
  { inner: PYRIC_PORT, socket: 'pyric.sock', offset: 1, isPublic: false },
];

interface ServeOptions {
  runDir: string;
  commit: string;
  root: string;
  port: number;
  host: string;
  owner: Owner;
  /** The served copy's provider socket, bound read-only and bridged from 127.0.0.1:4180. */
  providerSocket?: string;
}

/** The status page for this process's commit, built from `last-served.json` on each request. */
function statusRoute(paths: AppPaths, commit: string): StatusRoute {
  return { path: STATUS_PATH, body: () => statusPage(commit, readLastServed(paths.lastServed)) };
}

function relayBridge(bridge: Bridge, reach: string, options: ServeOptions, route: StatusRoute) {
  const port = options.port + bridge.offset;
  const socket = join(reach, bridge.socket);
  if (!bridge.isPublic) return relayPortToSocket(port, socket);
  return relayPortToSocket(port, socket, options.host, route);
}

/** Resolves with why the copy stops: a signal from the harness, or its owner gone (`served-owner.ts`). */
function stopReason(owner: Owner): Promise<StopReason> {
  return new Promise((resolve) => {
    process.once('SIGTERM', () => resolve({ ownerGone: false, why: 'SIGTERM' }));
    process.once('SIGINT', () => resolve({ ownerGone: false, why: 'SIGINT' }));
    watchOwner(owner, (why) => resolve({ ownerGone: true, why }));
  });
}

interface StopReason {
  ownerGone: boolean;
  why: string;
}

/** With its owner gone nothing else will remove the copy's private-network entry, so the copy does. */
function afterStop(paths: AppPaths, reason: StopReason): void {
  const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
  log(`the served copy stops: ${reason.why}`);
  if (!reason.ownerGone) return;
  for (const line of removeRecordedEntries(paths)) log(line);
}

async function serve(options: ServeOptions): Promise<void> {
  const { runDir, commit, root, port, owner } = options;
  const paths = appPaths(runDir);
  const stateFile = servedStateFile(paths);
  const base = { pid: process.pid, startTime: startTimeOf(process.pid) ?? '', runDir, commit, port, startedAt: new Date().toISOString() };
  writeJson(stateFile, { ...base, status: 'starting' });
  const stopped = stopReason(owner);
  const checkout = checkoutAt(root);
  try {
    const providerBinds = options.providerSocket === undefined ? [] : [options.providerSocket];
    await openSandbox(specAt(root, undefined, providerBinds), paths, async (runner, namespace) => {
      await unpackTree(runner, checkout);
      await installStudio({ runner, namespace, checkout, withRoot: false, say: (line) => console.log(`▸ ${line}`) });
      const app = await startApp({ checkout, namespace, logFile: join(checkout.logs, 'studio.log'), ...allowedHostOption(options.host), ...optional('ffmpeg', process.env.FFMPEG_BIN), publicBridgePort: port + 1, provider: options.providerSocket !== undefined });
      const sockets = join(root, 'sockets');
      if (options.providerSocket !== undefined) startInsideBridge(namespace, ['tcp-to-unix', String(PROVIDER_BRIDGE_PORT), options.providerSocket], sockets);
      for (const bridge of BRIDGES) startInsideBridge(namespace, ['unix-to-tcp', bridge.socket, String(bridge.inner)], sockets);
      const reach = insideSandbox(namespace.pid, sockets);
      for (const bridge of BRIDGES) await waitForSocket(join(reach, bridge.socket));
      const route = statusRoute(paths, commit);
      const servers = await Promise.all(BRIDGES.map((bridge) => relayBridge(bridge, reach, options, route)));
      writeJson(stateFile, { ...base, status: 'ready' });
      const reason = await stopped;
      for (const server of servers) server.close();
      await app.stop();
      afterStop(paths, reason);
    });
  } catch (error) {
    writeJson(stateFile, { ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runDir = flagValue(args, '--run-dir');
  const commit = flagValue(args, '--commit');
  const root = flagValue(args, '--root');
  if (runDir === undefined || commit === undefined || root === undefined) throw new Error(`usage: ${USAGE}`);
  const port = Number(flagValue(args, '--port') ?? DEFAULT_SERVED_PORT);
  const host = flagValue(args, '--host') ?? LOOPBACK;
  const owner = parseOwner((flag) => flagValue(args, flag));
  const providerSocket = flagValue(args, '--provider-socket');
  await serve({ runDir, commit, root, port, host, owner, ...optional('providerSocket', providerSocket) });
  process.exit();
}
