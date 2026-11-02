/**
 * Serves the last good commit until it is stopped, detached from the check
 * that started it:
 *
 *   bun test/builders/factory/served-process.ts --run-dir <dir> --commit <sha> [--port 4120]
 *
 * Studio runs from `<runDir>/served/app` in a sandbox of its own, as the
 * check runs it, so the served copy reaches no Google host either. The host
 * reaches it through two Unix sockets in the run root (`socket-bridge.ts`):
 * `--port` carries Studio and `--port + 1` Pyric's WebSocket, which a page
 * on the tailnet dials at that port (Studio's `NEXT_PUBLIC_PYRIC_BRIDGE_PORT`).
 * Both listen on 127.0.0.1, which the tailnet serve entries point at.
 *
 * It writes `served/served.json` (`starting`, then `ready` or `failed`) and
 * stops Studio and the sandbox on SIGTERM or SIGINT.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { flagValue } from '../cli-args.ts';
import type { EgressNamespace } from '../namespace.ts';
import { appPaths, type AppPaths } from './app-paths.ts';
import { APP_PORT, PYRIC_PORT, startApp } from './app-start.ts';
import { openSandbox } from './sandbox.ts';
import { pipeBoth } from './socket-bridge.ts';
import { writeJsonFile } from './run-dir.ts';
import { tailnetHost } from './tailnet.ts';

/** The private network's host name, which Next must allow as a dev origin, when there is one. */
function allowedHostOption(): { allowedHost?: string } {
  const host = tailnetHost();
  return host === undefined ? {} : { allowedHost: host };
}

const SOCKET_BRIDGE = fileURLToPath(new URL('./socket-bridge.ts', import.meta.url));
export const DEFAULT_SERVED_PORT = 4120;
const SOCKET_WAIT_MS = 15_000;

export const servedStateSchema = z.object({
  pid: z.number().int(),
  commit: z.string(),
  port: z.number().int(),
  status: z.enum(['starting', 'ready', 'failed']),
  startedAt: z.string(),
  error: z.string().optional(),
}).strict();

export type ServedState = z.infer<typeof servedStateSchema>;

export function servedStateFile(paths: AppPaths): string {
  return join(paths.served.root, 'served.json');
}

function socketsDir(paths: AppPaths): string {
  return join(paths.served.root, 'sockets');
}

async function waitForFile(path: string, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error(`${path} did not appear within ${ms / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Starts the inside half for one port and the host half on `hostPort`. */
async function bridge(namespace: EgressNamespace, socket: string, innerPort: number, hostPort: number): Promise<Server> {
  const entered = namespace.enter('node', [SOCKET_BRIDGE, socket, String(innerPort)], '/');
  spawn(entered.command, entered.args, { stdio: 'ignore', env: { PATH: process.env.PATH ?? '' } });
  await waitForFile(socket, SOCKET_WAIT_MS);
  const server = createServer((client) => pipeBoth(client, connect(socket)));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(hostPort, '127.0.0.1', () => resolve());
  });
  return server;
}

async function serve(runDir: string, commit: string, port: number): Promise<void> {
  const paths = appPaths(runDir);
  const stateFile = servedStateFile(paths);
  const base = { pid: process.pid, commit, port, startedAt: new Date().toISOString() };
  writeJsonFile(stateFile, { ...base, status: 'starting' });
  mkdirSync(socketsDir(paths), { recursive: true });
  const stop = new Promise<void>((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
  });
  try {
    await openSandbox(paths.served.root, paths, async (_runner, namespace) => {
      const app = await startApp({
        checkout: paths.served,
        namespace,
        logFile: join(paths.served.logs, 'studio.log'),
        ...allowedHostOption(),
        publicBridgePort: port + 1,
      });
      const servers = [
        await bridge(namespace, join(socketsDir(paths), 'app.sock'), APP_PORT, port),
        await bridge(namespace, join(socketsDir(paths), 'pyric.sock'), PYRIC_PORT, port + 1),
      ];
      writeJsonFile(stateFile, { ...base, status: 'ready' });
      await stop;
      for (const server of servers) server.close();
      await app.stop();
    });
  } catch (error) {
    writeJsonFile(stateFile, { ...base, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const runDir = flagValue(args, '--run-dir');
  const commit = flagValue(args, '--commit');
  if (runDir === undefined || commit === undefined) throw new Error('usage: bun served-process.ts --run-dir <dir> --commit <sha> [--port <n>]');
  const port = Number(flagValue(args, '--port') ?? DEFAULT_SERVED_PORT);
  await serve(runDir, commit, port);
  process.exit();
}
