import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Server-sent-events hub for `/__pyric/events` -- the hot-reload channel
 * (P3). The runtime opens an EventSource; the rules watcher broadcasts
 * `rules-changed` and connected pages re-deploy without a refresh.
 */
export interface ServeEventHub {
  /** Mounted inside the namespace handler. */
  handle(req: IncomingMessage, res: ServerResponse): void;
  broadcast(event: string, data: unknown): void;
  clientCount(): number;
  /** End all open streams. Idempotent; used by host-neutral session cleanup. */
  close(): void;
}

export function createEventHub(): ServeEventHub {
  const clients = new Set<ServerResponse>();
  let closed = false;
  return {
    handle(req, res) {
      if (closed) {
        res.writeHead(503, { 'content-type': 'text/plain' }).end('sandbox session closed');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      // A dying SSE socket must never surface an unhandled 'error' event
      // (which would kill the whole serve process) -- drop the client instead.
      res.on('error', () => clients.delete(res));
    },
    broadcast(event, data) {
      if (closed) return;
      const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const res of clients) {
        try {
          res.write(frame);
        } catch {
          clients.delete(res); // half-closed socket in the close race window
        }
      }
    },
    clientCount: () => clients.size,
    close() {
      if (closed) return;
      closed = true;
      for (const res of clients) res.end();
      clients.clear();
    },
  };
}
