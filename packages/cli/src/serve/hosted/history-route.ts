import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostedHistory } from './persistence/history.js';
/** Authentication and host checks are performed by the namespace router. */
export function handleHistory(history: HostedHistory, request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  try {
    const flush = request.method === 'POST' && url.searchParams.get('action') === 'flush';
    if (flush) {
      history.flush();
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(history.status()));
      return true;
    }
    const read = request.method === 'GET';
    const unsupportedMethod = !read;
    if (unsupportedMethod) {
      response.writeHead(405).end();
      return true;
    }
    const listing = url.searchParams.get('action') === 'list';
    let value: unknown = history.status();
    if (listing) {
      const through = url.searchParams.get('through');
      const hasThrough = through !== null;
      value = history.list({ after: Number(url.searchParams.get('after') ?? 0),
        through: hasThrough ? Number(through) : undefined, limit: Number(url.searchParams.get('limit') ?? 100),
        service: url.searchParams.get('service') ?? undefined });
    }
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
  }
  catch (error) {
    const isError = error instanceof Error;
    const message = isError ? error.message : String(error);
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: message }));
  }
  return true;
}
