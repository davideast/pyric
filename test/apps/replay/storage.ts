// Cloud Storage's REST surface (`/v0/b/<bucket>/o...`), answered from
// recorded `storage` exchanges. A request matches on its method, bucket,
// object, query, upload protocol and command, the uid its
// `Authorization: Firebase <token>` header names, and, when the exchange
// holds them, the metadata JSON and the object bytes it sent. The answer is
// the recorded status, headers and body with its placeholders filled.
//
// Fails closed: a request no exchange answers gets a 400 whose message starts
// `pyric_replay_no_recording:` and is listed in `unmatched`. Not a 5xx, a 408
// or a 429: the SDK retries those for up to two minutes (`isRetryStatusCode`
// in `@firebase/storage`), so a missing recording would hang the test
// instead of failing it.
import { createHash, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { placeholderName, type Json, type JsonObject, type StorageExchange } from './format.ts';
import type { ReplayState } from './firestore.ts';
import { fill, matches } from './values.ts';

export const STORAGE_HOST = 'firebasestorage.googleapis.com';

/** The first path segment of a Storage call `connectStorageEmulator` builds. */
export const STORAGE_VERSION_SEGMENT = 'v0';

const STORAGE_PATH = /^\/v0\/b\/([^/]+)\/o(?:\/(.+))?$/;

export const NO_RECORDING = 'pyric_replay_no_recording';

/** One Storage call as the replay matches it. */
export interface StorageRequest {
  method: string;
  bucket: string;
  object?: string;
  query: JsonObject;
  upload?: { protocol: string; command?: string };
  metadata?: JsonObject;
  bytes?: { length: number; sha256: string };
  /** The uid the Authorization header named, null for none or a token this server did not mint. */
  as: string | null;
}

/** One Storage call the server received. It names the call and its bytes' length, never the bytes. */
export interface StorageReceived {
  rpc: 'storage';
  as: string | null;
  message: JsonObject;
}

export interface StorageAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** The bucket and object a Storage path names, or null for a path that is not one. */
export function storagePathOf(path: string): { bucket: string; object?: string } | null {
  const match = STORAGE_PATH.exec(path);
  if (!match) return null;
  const bucket = decodeURIComponent(match[1]!);
  return match[2] === undefined ? { bucket } : { bucket, object: decodeURIComponent(match[2]) };
}

/** Reads one Storage call from its path, query, headers and raw body. */
export function readStorageRequest(state: ReplayState, method: string, path: string, query: URLSearchParams, headers: IncomingHttpHeaders, body: Buffer): StorageRequest | null {
  const target = storagePathOf(path);
  if (!target) return null;
  const token = /^Firebase (.+)$/.exec(headerOf(headers, 'authorization') ?? '')?.[1];
  const protocol = headerOf(headers, 'x-goog-upload-protocol');
  const command = headerOf(headers, 'x-goog-upload-command');
  const request: StorageRequest = { method, ...target, query: Object.fromEntries(query), as: state.tokens.uidOf(token) };
  if (protocol) request.upload = command ? { protocol, command } : { protocol };
  Object.assign(request, sentContent(headerOf(headers, 'content-type') ?? '', body));
  return request;
}

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** The metadata JSON and object bytes a body carries: a multipart upload's two parts, or a JSON body. */
function sentContent(contentType: string, body: Buffer): Pick<StorageRequest, 'metadata' | 'bytes'> {
  const boundary = /^multipart\/related;\s*boundary=(.+)$/i.exec(contentType)?.[1];
  if (boundary) return multipartContent(boundary, body);
  const isJson = contentType.startsWith('application/json') && body.length > 0;
  return isJson ? { metadata: JSON.parse(body.toString('utf8')) as JsonObject } : {};
}

/**
 * The SDK's multipart body: `--<boundary>`, the metadata JSON part, `--<boundary>`,
 * the bytes part, `--<boundary>--`, with CRLF line ends and a blank line
 * after each part's Content-Type.
 */
function multipartContent(boundary: string, body: Buffer): Pick<StorageRequest, 'metadata' | 'bytes'> {
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const framed = Buffer.concat([Buffer.from('\r\n'), body]);
  const parts: Buffer[] = [];
  let start = framed.indexOf(delimiter);
  while (start !== -1) {
    const next = framed.indexOf(delimiter, start + delimiter.length);
    if (next === -1) break;
    parts.push(framed.subarray(start + delimiter.length, next));
    start = next;
  }
  const [metadataPart, bytesPart] = parts.map(partContent);
  if (metadataPart === undefined || bytesPart === undefined) return {};
  const bytes = { length: bytesPart.length, sha256: createHash('sha256').update(bytesPart).digest('hex') };
  return { metadata: JSON.parse(metadataPart.toString('utf8')) as JsonObject, bytes };
}

/** A part's content: everything after the blank line that ends its headers. */
function partContent(part: Buffer): Buffer {
  const headersEnd = part.indexOf('\r\n\r\n');
  return headersEnd === -1 ? Buffer.alloc(0) : part.subarray(headersEnd + 4);
}

/** The values production picks for one object, chosen once so every answer about it agrees. */
interface ObjectValues {
  downloadToken: string;
  generation: string;
  timeCreated: string;
}

/** Storage state one replay server keeps: the calls it received, the objects it named, the upload ids it issued. */
export class StorageReplay {
  readonly received: StorageReceived[] = [];
  private readonly objects = new Map<string, ObjectValues>();
  private readonly sessions = new Set<string>();
  private readonly used = new Set<string>();
  private lastGeneration = 0;

  constructor(private readonly state: ReplayState) {}

  /** The answer to one call. `origin` is the server's own, where an upload URL points. */
  answer(request: StorageRequest, origin: string): StorageAnswer {
    this.received.push({ rpc: 'storage', as: request.as, message: describe(request) });
    const exchange = this.take(request);
    if (!exchange) return this.refuse(request);
    const object = request.object ?? stringOf(request.query.name);
    const headers = Object.fromEntries(Object.entries(exchange.response.headers ?? {}).map(([name, value]) => [name, this.headerValue(value, request, origin)]));
    const body = exchange.response.body;
    const filled = body === null ? null : fill(this.fillObject(body, request.bucket, object), this.state.context());
    const text = filled === null ? '' : typeof filled === 'string' ? filled : JSON.stringify(filled);
    return { status: exchange.response.status, headers, body: text };
  }

  /** The first fitting exchange not yet used, or the last fitting one when all are. */
  private take(request: StorageRequest): StorageExchange | null {
    const candidates = this.state.recordings
      .flatMap((recording) => recording.exchanges)
      .filter((exchange): exchange is StorageExchange => exchange.kind === 'storage' && this.fits(exchange, request));
    const chosen = candidates.find((exchange) => !this.used.has(exchange.id)) ?? candidates.at(-1) ?? null;
    if (chosen) this.used.add(chosen.id);
    return chosen;
  }

  private fits(exchange: StorageExchange, request: StorageRequest): boolean {
    const recorded = exchange.request;
    const sameAccount = exchange.as === undefined || exchange.as === request.as;
    const sameCall = recorded.method === request.method && recorded.bucket === request.bucket && recorded.object === request.object;
    const sameUpload = recorded.upload?.protocol === request.upload?.protocol && recorded.upload?.command === request.upload?.command;
    const sameMetadata = recorded.metadata === undefined || matches(recorded.metadata, request.metadata);
    const sameBytes = recorded.bytes === undefined || (recorded.bytes.length === request.bytes?.length && recorded.bytes.sha256 === request.bytes.sha256);
    return sameAccount && sameCall && sameUpload && sameMetadata && sameBytes && this.queryFits(recorded.query ?? {}, request.query);
  }

  /** The whole query matches, where `uploadSession` matches an upload id this server issued. */
  private queryFits(recorded: JsonObject, actual: JsonObject): boolean {
    const keys = Object.keys(recorded).sort();
    const sameKeys = keys.join('&') === Object.keys(actual).sort().join('&');
    return sameKeys && keys.every((key) => {
      const isSession = placeholderName(recorded[key]) === 'uploadSession';
      return isSession ? this.sessions.has(String(actual[key])) : matches(recorded[key], actual[key]);
    });
  }

  private refuse(request: StorageRequest): StorageAnswer {
    const object = request.object ?? stringOf(request.query.name) ?? '';
    const message = `${NO_RECORDING}: no recorded Storage call answers ${request.method} gs://${request.bucket}/${object}`;
    this.state.unmatched.push({ rpc: 'http', as: request.as, request: { service: 'storage', ...describe(request) } });
    return { status: 400, headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ error: { code: 400, message } }) };
  }

  /** A header value, with an `uploadSession` placeholder filled with a fresh upload URL on this server. */
  private headerValue(value: Json, request: StorageRequest, origin: string): string {
    if (placeholderName(value) !== 'uploadSession') return String(value);
    const id = `replay-upload-${randomUUID()}`;
    this.sessions.add(id);
    const name = stringOf(request.query.name) ?? request.object ?? '';
    const query = new URLSearchParams({ name, upload_id: id, upload_protocol: 'resumable' });
    return `${origin}/v0/b/${encodeURIComponent(request.bucket)}/o?${query}`;
  }

  /** A copy of `body` with each object's download token, generation and creation time filled. */
  private fillObject(body: Json, bucket: string, object: string | undefined): Json {
    if (Array.isArray(body)) return body.map((item) => this.fillObject(item, bucket, object));
    const isObject = typeof body === 'object' && body !== null;
    if (!isObject) return body;
    const name = placeholderName(body);
    if (name === 'downloadToken' || name === 'generation' || name === 'timeCreated') return this.valuesOf(bucket, object)[name];
    if (name !== null) return body;
    const resource = typeof body.name === 'string' ? body.name : object;
    return Object.fromEntries(Object.entries(body).map(([key, item]) => [key, this.fillObject(item, bucket, resource)]));
  }

  private valuesOf(bucket: string, object: string | undefined): ObjectValues {
    const key = `${bucket}/${object ?? ''}`;
    let values = this.objects.get(key);
    if (!values) {
      // A generation is the object's write time in microseconds, as production's are.
      this.lastGeneration = Math.max(Date.now() * 1000, this.lastGeneration + 1);
      const timeCreated = new Date(Math.floor(this.lastGeneration / 1000)).toISOString();
      values = { downloadToken: randomUUID(), generation: String(this.lastGeneration), timeCreated };
      this.objects.set(key, values);
    }
    return values;
  }
}

function stringOf(value: Json | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A request as `received` and `unmatched` list it: the call, never the bytes. */
function describe(request: StorageRequest): JsonObject {
  const described: JsonObject = { method: request.method, bucket: request.bucket, query: request.query };
  if (request.object !== undefined) described.object = request.object;
  if (request.upload) described.upload = request.upload;
  if (request.bytes) described.bytes = request.bytes.length;
  return described;
}
