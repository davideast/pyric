import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RemoteSandbox, RemoteSandboxChannel } from '../../src/remote/index.js';
import { resolveSessionTokenForTarget } from '../../src/serve/local-session-token.js';
import { wirePort } from '../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../src/serve/worker/client/storage.js';
import type { InboundMessage } from '../../src/serve/worker/protocol.js';

export const cliRoot = resolve(import.meta.dir, '../..');
export const repoRoot = resolve(cliRoot, '../..');
export const cliEntry = join(cliRoot, 'dist/cli/index.js');
export const childModule = join(cliRoot, 'dist/functions/child.js');

export interface TriggerReceipt {
  id: string;
  source: string;
  specversion: string;
  type: string;
  time: string;
  subject: string;
  bucket: string;
  location: string;
  name: string;
  dataBucket: string;
  size: string;
  sizeType: string;
  generation: string;
  metageneration: string;
  contentType: string;
  md5Hash: string;
  crc32c: string;
  etag: string;
  storageClass: string;
  cacheControl: string | null;
  contentDisposition: string | null;
  contentLanguage: string | null;
  metadata: Record<string, string> | null;
  downloadedText: string;
}

export interface HostedNodeServer {
  url: string;
  instanceId?: string;
  sessionToken?: string;
  stop(): Promise<void>;
}

/**
 * Spawn `pyric sandbox --hosted --bridge --permissive` in a real Node process
 * so `HostedRuntime` (`node:sqlite` + HTTP byte route) runs natively alongside
 * `bun test`.
 */
export async function startNodeHostedRuntime(
  cwd: string,
  projectId = 'demo-project',
): Promise<HostedNodeServer> {
  if (!existsSync(cliEntry)) {
    throw new Error(`CLI entry is not built: ${cliEntry}`);
  }
  let output = '';
  const proc: ChildProcess = spawn(
    process.env.PYRIC_TEST_NODE ?? 'node',
    [
      cliEntry,
      'sandbox',
      '--hosted',
      '--bridge',
      '--permissive',
      `--project=${projectId}`,
      '--port=0',
      '--host=127.0.0.1',
      '--no-open',
      '--no-capture',
    ],
    {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  proc.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });
  proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
  });

  const pointerPath = join(cwd, '.pyric/serve.json');
  let pointer: { url: string; instanceId?: string } | undefined;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`HostedRuntime exited early (${proc.exitCode}):\n${output}`);
    }
    if (existsSync(pointerPath)) {
      try {
        const parsed = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
          url?: unknown;
          instanceId?: unknown;
        };
        if (typeof parsed.url === 'string' && parsed.url.length > 0) {
          pointer = {
            url: parsed.url.replace(/\/$/, ''),
            instanceId: typeof parsed.instanceId === 'string' ? parsed.instanceId : undefined,
          };
          break;
        }
      } catch {
        // Wait for atomic pointer write to finish.
      }
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  if (pointer === undefined) {
    proc.kill('SIGKILL');
    throw new Error(`Timed out waiting for HostedRuntime pointer:\n${output}`);
  }

  const sessionToken = resolveSessionTokenForTarget({ url: pointer.url, cwd });

  return {
    url: pointer.url,
    instanceId: pointer.instanceId,
    sessionToken,
    async stop() {
      if (proc.exitCode !== null || proc.signalCode !== null) return;
      await new Promise<void>((resolveStopped) => {
        const forceTimer = setTimeout(() => {
          if (proc.exitCode === null && proc.signalCode === null) {
            proc.kill('SIGKILL');
          }
        }, 5_000);
        forceTimer.unref();
        proc.once('exit', () => {
          clearTimeout(forceTimer);
          resolveStopped();
        });
        proc.kill('SIGINT');
      });
    },
  };
}

/** Bridge a worker-client `ClientPort` onto an attached `RemoteSandbox`. */
export function createChannelClientPort(
  sandbox: RemoteSandbox,
  byteRoute?: { baseUrl: string; sessionToken?: string },
): ClientPort {
  let clientPort: ClientPort;
  const deliver = (payload: unknown): void => {
    queueMicrotask(() => {
      clientPort.onmessage?.(new MessageEvent('message', { data: payload }));
    });
  };

  clientPort = {
    onmessage: null,
    start() {},
    close() {},
    postMessage(raw: unknown) {
      const msg = raw as InboundMessage;
      if (msg.t !== 'op') return;
      const { t: _ignoredT, id, ...rest } = msg as unknown as Record<string, unknown> & {
        t: string;
        id: string;
        method: string;
      };
      void sandbox.channel
        .op(rest as Parameters<RemoteSandboxChannel['op']>[0])
        .then((value) => {
          deliver({ t: 'res', id, ok: true, value });
        })
        .catch((error: unknown) => {
          let code = 'unknown';
          const candidateCode = (error as { code?: unknown } | null)?.code;
          if (typeof candidateCode === 'string') {
            code = candidateCode;
          }
          const message = error instanceof Error ? error.message : String(error);
          deliver({ t: 'res', id, ok: false, error: { code, message } });
        });
    },
  };

  if (byteRoute !== undefined) {
    clientPort.byteRoute = {
      baseUrl: byteRoute.baseUrl,
      sessionToken: async () => byteRoute.sessionToken ?? null,
    };
  }
  wirePort(clientPort);
  return clientPort;
}

export async function waitForRtdbValue<T>(
  sandbox: RemoteSandbox,
  path: string,
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = (await sandbox.rtdb.get(path)) as T | null;
    if (current !== null && current !== undefined) return current;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
  }
  throw new Error(`timed out waiting for RTDB receipt at ${path}`);
}
