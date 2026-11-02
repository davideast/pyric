/**
 * Serves the last good commit until it is stopped, detached from the check
 * that started it:
 *
 *   bun test/builders/factory/served-process.ts --run-dir <dir> --commit <sha> --root <tree> [--port 4120]
 *
 * `<tree>` is a fresh directory of `<run>.work/` holding the commit's tar
 * (`tree.ts`). In a sandbox rooted there, as the check runs it, it unpacks
 * and installs the commit and starts Studio, so the served copy reaches no
 * Google host either. The host reaches it through Unix sockets in that
 * sandbox, opened through `/proc/<pid>/root` (`relay.ts`): `--port` carries
 * Studio and `--port + 1` Pyric's WebSocket, both on 127.0.0.1. Only
 * `--port` is published on the private network (`served.ts`).
 *
 * It writes `<run>.host/served.json` (`starting`, then `ready` or `failed`)
 * with its pid and start time, which the harness checks before it signals
 * the pid, and stops Studio and the sandbox on SIGTERM or SIGINT.
 */
import { join } from 'node:path';
import { z } from 'zod';
import { flagValue } from '../cli-args.ts';
import { startTimeOf } from '../namespace.ts';
import { appPaths, checkoutAt, type AppPaths } from './app-paths.ts';
import { APP_PORT, PYRIC_PORT, startApp } from './app-start.ts';
import { optional } from './optional.ts';
import { insideSandbox, relayPortToSocket, startInsideBridge, waitForSocket } from './relay.ts';
import { openSandbox, specAt } from './sandbox.ts';
import { writeJson } from './state-files.ts';
import { installStudio } from './studio-install.ts';
import { tailnetHost } from './tailnet.ts';
import { unpackTree } from './tree.ts';

export const DEFAULT_SERVED_PORT = 4120;

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

/** The private network's host name, which Next must allow as a dev origin, when there is one. */
function allowedHostOption(): { allowedHost?: string } {
  return optional('allowedHost', tailnetHost());
}

const BRIDGES = [{ inner: APP_PORT, socket: 'app.sock', offset: 0 }, { inner: PYRIC_PORT, socket: 'pyric.sock', offset: 1 }];

async function serve(runDir: string, commit: string, root: string, port: number): Promise<void> {
  const paths = appPaths(runDir);
  const stateFile = servedStateFile(paths);
  const base = { pid: process.pid, startTime: startTimeOf(process.pid) ?? '', runDir, commit, port, startedAt: new Date().toISOString() };
  writeJson(stateFile, { ...base, status: 'starting' });
  const stopped = new Promise<void>((resolve) => {
    process.once('SIGTERM', () => resolve());
    process.once('SIGINT', () => resolve());
  });
  const checkout = checkoutAt(root);
  try {
    await openSandbox(specAt(root), paths, async (runner, namespace) => {
      await unpackTree(runner, checkout);
      await installStudio({ runner, namespace, checkout, withRoot: false, say: (line) => console.log(`▸ ${line}`) });
      const app = await startApp({ checkout, namespace, logFile: join(checkout.logs, 'studio.log'), ...allowedHostOption(), publicBridgePort: port + 1 });
      const sockets = join(root, 'sockets');
      for (const bridge of BRIDGES) startInsideBridge(namespace, ['unix-to-tcp', bridge.socket, String(bridge.inner)], sockets);
      const reach = insideSandbox(namespace.pid, sockets);
      for (const bridge of BRIDGES) await waitForSocket(join(reach, bridge.socket));
      const servers = await Promise.all(BRIDGES.map((bridge) => relayPortToSocket(port + bridge.offset, join(reach, bridge.socket))));
      writeJson(stateFile, { ...base, status: 'ready' });
      await stopped;
      for (const server of servers) server.close();
      await app.stop();
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
  if (runDir === undefined || commit === undefined || root === undefined) throw new Error('usage: bun served-process.ts --run-dir <dir> --commit <sha> --root <tree> [--port <n>]');
  const port = Number(flagValue(args, '--port') ?? DEFAULT_SERVED_PORT);
  await serve(runDir, commit, root, port);
  process.exit();
}
