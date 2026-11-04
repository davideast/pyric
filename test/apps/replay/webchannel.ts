// The server side of WebChannel, the transport the Firestore web SDK runs its
// Listen and Write streams over (protocol version 8, as
// `@firebase/webchannel-wrapper` speaks it). One stream is one session:
//
// - The handshake is a POST with no SID. Its answer is the chunk
//   `[[0,["c",<sid>,"",8,14,<keepalive ms>]]]` and an `X-HTTP-Session-Id` header.
// - The client sends its messages in POSTs, form-encoded as
//   `count=N&ofs=K&req0___data__=<json>...`, and the handshake carries the first
//   ones. Each POST is answered with the chunk `[1,<last array id sent>,0]`.
// - The server sends its messages on the back channel, a GET with
//   `RID=rpc&TYPE=xmlhttp`, as chunks `<length>\n[[<array id>,[<message>]],...]`.
//   With `CI=0` the GET streams; with `CI=1` (long polling) it ends after each send.
// - `TYPE=terminate` ends the session.
//
// Each chunk is its JSON text preceded by its length in UTF-16 code units and
// a newline, which is how the client's decoder counts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { JsonObject } from './format.ts';

/** What one forward POST carried. */
export interface ForwardBatch {
  /** The `headers` field, sent with the first POST only (`encodeInitMessageHeaders`). */
  headers: Record<string, string>;
  /** Message id of each message, from `ofs`. */
  messages: Array<{ id: number; message: JsonObject }>;
}

/** Parses a forward POST body. */
export function parseForwardBody(body: string): ForwardBatch {
  const form = new URLSearchParams(body);
  const count = Number(form.get('count') ?? '0');
  const offset = Number(form.get('ofs') ?? '0');
  const messages: ForwardBatch['messages'] = [];
  for (let index = 0; index < count; index++) {
    const data = form.get(`req${index}___data__`);
    if (data !== null) messages.push({ id: offset + index, message: JSON.parse(data) as JsonObject });
  }
  return { headers: parseHeaderBlock(form.get('headers') ?? ''), messages };
}

/** `Name:value\r\n` lines, as WebChannel encodes init headers. */
export function parseHeaderBlock(block: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of block.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** One length-prefixed chunk. */
export function chunk(payload: unknown): string {
  const text = JSON.stringify(payload);
  return `${text.length}\n${text}`;
}

/** Splits a chunked body into its JSON payloads; `rest` is an incomplete tail. */
export function splitChunks(text: string): { payloads: unknown[]; rest: string } {
  const payloads: unknown[] = [];
  let at = 0;
  for (;;) {
    const newline = text.indexOf('\n', at);
    if (newline === -1) break;
    const length = Number(text.slice(at, newline));
    const end = newline + 1 + length;
    if (Number.isNaN(length) || end > text.length) break;
    payloads.push(JSON.parse(text.slice(newline + 1, end)));
    at = end;
  }
  return { payloads, rest: text.slice(at) };
}

/** Server keepalive the handshake announces; the client waits 1.5 times this on a back channel. */
const KEEPALIVE_MS = 30_000;
/** How often an idle streaming back channel gets a noop. */
const NOOP_MS = 20_000;

/** What a session does with the client's messages. */
export interface StreamHandler {
  onMessage(message: JsonObject): void;
  onClose(): void;
}

export class WebChannelSession {
  readonly sid = randomBytes(12).toString('base64url');
  readonly gsessionid = randomBytes(12).toString('base64url');
  /** Arrays sent and not yet acknowledged by an `AID`. */
  private pending: Array<[number, unknown[]]> = [];
  private nextArrayId = 1;
  private nextMessageId = 0;
  private backChannel: { response: ServerResponse; streaming: boolean; written: number } | null = null;
  private noop: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  handler: StreamHandler | null = null;

  /** The handshake answer. */
  handshake(response: ServerResponse): void {
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'x-http-session-id': this.gsessionid });
    response.end(chunk([[0, ['c', this.sid, '', 8, 14, KEEPALIVE_MS]]]));
  }

  /** Takes a forward batch's new messages, in order, skipping any a retry resent. */
  receive(batch: ForwardBatch): void {
    for (const { id, message } of batch.messages) {
      const isRetry = id < this.nextMessageId;
      if (isRetry) continue;
      this.nextMessageId = id + 1;
      this.handler?.onMessage(message);
    }
  }

  /** The answer to a forward POST after the handshake. Its `AID` says which arrays the client has. */
  acknowledge(response: ServerResponse, url: URL): void {
    const acknowledged = Number(url.searchParams.get('AID') ?? '0');
    this.pending = this.pending.filter(([id]) => id > acknowledged);
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
    response.end(chunk([1, this.nextArrayId - 1, 0]));
  }

  /** Queues one server message and flushes it to the back channel. */
  send(message: JsonObject | JsonObject[] | string[]): void {
    if (this.closed) return;
    this.pending.push([this.nextArrayId++, Array.isArray(message) ? message : [message]]);
    this.flush();
  }

  /** Sends a stream error, as the server does before it drops a stream. */
  fail(error: { code: number; status: string; message: string }): void {
    this.send({ error });
  }

  /** Attaches a back-channel GET, resending what the client has not acknowledged. */
  attachBackChannel(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const acknowledged = Number(url.searchParams.get('AID') ?? '0');
    this.pending = this.pending.filter(([id]) => id > acknowledged);
    this.detachBackChannel();
    const streaming = url.searchParams.get('CI') === '0';
    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    this.backChannel = { response, streaming, written: acknowledged };
    request.on('close', () => {
      if (this.backChannel?.response === response) this.backChannel = null;
    });
    if (streaming) {
      // A first noop shows the client's buffering-proxy check that bytes arrive.
      this.send(['noop']);
      this.noop = setInterval(() => this.send(['noop']), NOOP_MS);
      this.noop.unref?.();
    }
    this.flush();
  }

  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachBackChannel();
    this.handler?.onClose();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private flush(): void {
    const channel = this.backChannel;
    const unwritten = this.pending.filter(([id]) => id > (channel?.written ?? Infinity));
    if (!channel || unwritten.length === 0) return;
    channel.response.write(chunk(unwritten));
    channel.written = unwritten[unwritten.length - 1]![0];
    if (!channel.streaming) {
      channel.response.end();
      this.backChannel = null;
    }
  }

  private detachBackChannel(): void {
    if (this.noop) clearInterval(this.noop);
    this.noop = null;
    const channel = this.backChannel;
    this.backChannel = null;
    if (channel && !channel.response.writableEnded) channel.response.end();
  }
}
