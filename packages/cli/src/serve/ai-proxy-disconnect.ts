import type { IncomingMessage, ServerResponse } from 'node:http';

export interface AiProxyClientDisconnect {
  readonly signal: AbortSignal;
  isDisconnected(): boolean;
  dispose(): void;
}

/**
 * Tracks a proxied HTTP client's connection before and during an upstream
 * fetch (#1634). Listens on `req` `'aborted'` and `res` `'close'` (guarded by
 * `!res.writableEnded`), never unconditional `req` `'close'` which Node
 * `IncomingMessage` emits as soon as a POST request body finishes reading.
 */
export function watchAiProxyClientDisconnect(
  req: IncomingMessage,
  res: ServerResponse,
): AiProxyClientDisconnect {
  const controller = new AbortController();
  let disconnected = false;

  const abortOnClientDrop = (): void => {
    if (res.writableEnded) return;
    disconnected = true;
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  req.on('aborted', abortOnClientDrop);
  res.on('close', abortOnClientDrop);

  const alreadyDropped = Boolean(req.aborted) || (Boolean(res.destroyed) && !res.writableEnded);
  if (alreadyDropped) {
    abortOnClientDrop();
  }

  const dispose = (): void => {
    req.off('aborted', abortOnClientDrop);
    res.off('close', abortOnClientDrop);
  };

  return {
    signal: controller.signal,
    isDisconnected: () => disconnected || (Boolean(res.destroyed) && !res.writableEnded),
    dispose,
  };
}
