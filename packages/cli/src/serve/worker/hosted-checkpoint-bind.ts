/**
 * Browser-safe symbol bridge letting `serve-init.ts` bind `ctx.sandbox` to a
 * Node `HostedDatabase` via `ctx.checkpointBackend` without importing `node:*`
 * modules into the SharedWorker bundle.
 */
import type { Sandbox } from 'pyric/sandbox';
import type { CheckpointBackend } from 'pyric/sandbox/checkpoints';

export const BIND_HOSTED_SANDBOX_SYMBOL = Symbol.for('pyric.hosted.bindSandbox');

export function bindSandboxToCheckpointBackend(
  checkpointBackend: CheckpointBackend | undefined,
  sandbox: Sandbox,
): boolean {
  if (checkpointBackend === undefined) return false;
  const hook = (
    checkpointBackend as unknown as Record<symbol, ((sb: Sandbox) => void) | undefined>
  )[BIND_HOSTED_SANDBOX_SYMBOL];
  if (typeof hook !== 'function') return false;
  hook(sandbox);
  return true;
}
