/**
 * Answers one path on the served copy's port itself and passes everything
 * else through to Studio unchanged, so the status page (`status-page.ts`)
 * sits at the served app's own host and port.
 *
 * The relay stays a byte pipe: it reads each request's head on the way in,
 * forwards the head and a `Content-Length` body to Studio, and reads the
 * next head after that. A request for the route's path gets the route's
 * page and the connection closes. A head it can't follow (an upgrade, a
 * chunked body, a bad length, or a head over 64 KiB) turns the rest of that
 * connection into a plain pipe. Browsers don't pipeline requests, so a
 * request only arrives once the response before it is done. (Bun's
 * `node:http` server drops what an upgraded socket writes, which is why this
 * isn't an HTTP proxy.)
 */
import type { Socket } from 'node:net';

const MAX_HEAD = 64 * 1024;
const HEAD_END = Buffer.from('\r\n\r\n');

export interface StatusRoute {
  path: string;
  /** The page's HTML, built on each request. */
  body: () => string;
}

export interface RequestHead {
  method: string;
  path: string;
  contentLength: number;
  /** Whether the rest of the connection can't be followed request by request. */
  passThrough: boolean;
}

function headersOf(lines: readonly string[]): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

/** Reads a request head, without its blank line. */
export function parseHead(head: string): RequestHead {
  const [requestLine = '', ...lines] = head.split('\r\n');
  const [method = '', target = ''] = requestLine.split(' ');
  const headers = headersOf(lines);
  const length = Number(headers.get('content-length') ?? '0');
  const isUpgrade = headers.has('upgrade');
  const isChunked = (headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked');
  const hasBadLength = !Number.isInteger(length) || length < 0;
  return { method, path: target.split('?')[0] ?? '', contentLength: hasBadLength ? 0 : length, passThrough: isUpgrade || isChunked || hasBadLength };
}

export function statusResponse(method: string, html: string): string {
  const body = Buffer.from(html, 'utf8');
  const head = ['HTTP/1.1 200 OK', 'Content-Type: text/html; charset=utf-8', `Content-Length: ${body.length}`, 'Cache-Control: no-store', 'Connection: close', '', ''].join('\r\n');
  const isHead = method === 'HEAD';
  return isHead ? head : head + html;
}

class Router {
  private pending = Buffer.alloc(0);
  private bodyLeft = 0;
  private passThrough = false;
  private upstream: Socket | undefined;
  private waitingForDrain = false;
  /** Set once the route answered: the connection is closing, so nothing more goes to Studio. */
  private answered = false;

  constructor(private readonly client: Socket, private readonly open: () => Socket, private readonly route: StatusRoute) {
    client.on('data', (chunk: Buffer) => this.take(chunk));
    client.once('end', () => this.upstream?.end());
    client.once('error', () => this.upstream?.destroy());
    client.once('close', () => this.upstream?.destroy());
  }

  private take(chunk: Buffer): void {
    if (this.answered) return;
    if (this.passThrough) return this.forward(chunk);
    this.pending = Buffer.concat([this.pending, chunk]);
    this.drain();
  }

  private drain(): void {
    while (this.pending.length > 0 && !this.passThrough) {
      if (this.bodyLeft > 0) {
        this.forwardBody();
        continue;
      }
      const end = this.pending.indexOf(HEAD_END);
      if (end === -1) {
        if (this.pending.length > MAX_HEAD) this.switchToPipe();
        return;
      }
      const headBytes = this.pending.subarray(0, end + HEAD_END.length);
      this.pending = this.pending.subarray(end + HEAD_END.length);
      const head = parseHead(headBytes.subarray(0, end).toString('latin1'));
      if (head.path === this.route.path) return this.answer(head);
      this.forward(headBytes);
      if (head.passThrough) return this.switchToPipe();
      this.bodyLeft = head.contentLength;
    }
  }

  private forwardBody(): void {
    const size = Math.min(this.bodyLeft, this.pending.length);
    this.forward(this.pending.subarray(0, size));
    this.pending = this.pending.subarray(size);
    this.bodyLeft -= size;
  }

  private switchToPipe(): void {
    this.passThrough = true;
    const rest = this.pending;
    this.pending = Buffer.alloc(0);
    if (rest.length > 0) this.forward(rest);
  }

  private answer(head: RequestHead): void {
    this.answered = true;
    this.client.end(statusResponse(head.method, this.route.body()));
    this.upstream?.destroy();
    this.pending = Buffer.alloc(0);
  }

  private forward(bytes: Buffer): void {
    const upstream = this.connected();
    const isFull = !upstream.write(bytes);
    if (!isFull || this.waitingForDrain) return;
    this.waitingForDrain = true;
    this.client.pause();
    upstream.once('drain', () => {
      this.waitingForDrain = false;
      this.client.resume();
    });
  }

  private connected(): Socket {
    if (this.upstream !== undefined) return this.upstream;
    const upstream = this.open();
    upstream.pipe(this.client);
    upstream.once('error', () => this.client.destroy());
    this.upstream = upstream;
    return upstream;
  }
}

/** Serves `route` on `client`'s connection and pipes every other request to the socket `open` connects. */
export function routeConnection(client: Socket, open: () => Socket, route: StatusRoute): void {
  new Router(client, open, route);
}
