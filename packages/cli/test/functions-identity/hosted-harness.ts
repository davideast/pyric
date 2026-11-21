import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RemoteSandbox, RemoteSandboxChannel } from '../../src/remote/index.js';
import { resolveSessionTokenForTarget } from '../../src/serve/local-session-token.js';
import { wirePort } from '../../src/serve/worker/client/core.js';
import type { ClientPort } from '../../src/serve/worker/client/handles.js';
import type { InboundMessage } from '../../src/serve/worker/protocol.js';

export const cliRoot = resolve(import.meta.dir, '../..');
export const repoRoot = resolve(cliRoot, '../..');
export const cliEntry = join(cliRoot, 'dist/cli/index.js');
export const childModule = join(cliRoot, 'dist/functions/child.js');

export interface HostedNodeServer {
  url: string;
  instanceId?: string;
  sessionToken?: string;
  stop(): Promise<void>;
}

/**
 * Spawn `pyric sandbox --hosted --bridge --permissive` in a real Node process
 * so `HostedRuntime` runs natively alongside `bun test`.
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
  const deadline = Date.now() + 45_000;
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
          let instanceId: string | undefined;
          if (typeof parsed.instanceId === 'string') {
            instanceId = parsed.instanceId;
          }
          pointer = {
            url: parsed.url.replace(/\/$/, ''),
            instanceId,
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
export function createChannelClientPort(sandbox: RemoteSandbox): ClientPort {
  let clientPort: ClientPort | undefined;
  const deliver = (payload: unknown): void => {
    queueMicrotask(() => {
      clientPort?.onmessage?.(new MessageEvent('message', { data: payload }));
    });
  };

  clientPort = {
    onmessage: null,
    start() {},
    close() {},
    postMessage(raw: unknown) {
      const msg = raw as InboundMessage;
      if (msg.t !== 'op' && msg.t !== 'sub' && msg.t !== 'unsub') return;
      if (msg.t === 'op') {
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
      }
    },
  };
  wirePort(clientPort);
  return clientPort;
}

/** Build an unsigned test OIDC JWT for `signInWithCredential` tests. */
export function makeTestOidcJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString(
    'base64url',
  );
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${header}.${payload}.`;
}
