// Cloud Storage's REST surface (`/v0/b/<bucket>/o...`), answered from
// recorded `storage` exchanges. A request matches on its method, bucket,
// object, query, upload protocol and command, the uid its
// `Authorization: Firebase <token>` header names, and, when the exchange
// holds them, the metadata JSON and the object bytes it sent. The answer is
// the recorded status, headers and body with its placeholders filled.
//
// A resumable upload's session is the replay's own: it counts the bytes each
// chunk sent, refuses a chunk whose offset is not that count, and answers a
// `query` with that count as `X-Goog-Upload-Size-Received`, so a resume after
// a pause continues from what this server received. The chunks' statuses and
// the final answer come from the recording. As production does, a session
// answers a chunk by its offset and whether it finalizes, not by its size: a
// resume may send the rest of the file in one final chunk where the recorded
// run sent two (capture S's `big.bin` shows production accepting that). A
// final chunk is answered only when the bytes its session received hash to
// the `md5Hash` of the object the recording finalized. An answer body
// `{ "$media": "<base64>" }` under a content type that is not JSON is an
// object's bytes (`alt=media`), sent as they are.
//
// Fails closed: a request no exchange answers, or one the replay cannot read
// (metadata that is not JSON, a path with a bad `%` escape), gets a 400 whose
// message starts `pyric_replay_no_recording:` and is listed in `unmatched`.
// Not a 5xx, a 408 or a 429: the SDK retries those (`isRetryStatusCode` in
// `@firebase/storage`) for up to 10 minutes on an upload
// (`maxUploadRetryTime`) and 2 on any other call, so a missing recording
// would hang the test instead of failing it.
import { createHash, randomUUID, type Hash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { placeholderName, type Json, type JsonObject, type StorageExchange } from './format.ts';
import type { ReplayState } from './firestore.ts';
import { fill, matches } from './values.ts';

export const STORAGE_HOST = 'firebasestorage.googleapis.com';

/** The first path segment of a Storage call `connectStorageEmulator` builds. */
export const STORAGE_VERSION_SEGMENT = 'v0';

const STORAGE_PATH = /^\/v0\/b\/([^/]+)\/o(?:\/(.+))?$/;

export const NO_RECORDING = 'pyric_replay_no_recording';

/** The key of an answer body that holds an object's bytes as base64. */
export const MEDIA_KEY = '$media';

/** One Storage call as the replay matches it. */
export interface StorageRequest {
  method: string;
  bucket: string;
  object?: string;
  query: JsonObject;
  upload?: { protocol: string; command?: string };
  metadata?: JsonObject;
  bytes?: { length: number; sha256: string };
  /** The `X-Goog-Upload-Offset` a resumable chunk sent. */
  offset?: number;
  /** The bytes a resumable chunk sent, which its session hashes. */
  chunk?: Buffer;
  /** The uid the Authorization header named, null for none or a token this server did not mint. */
  as: string | null;
  /** Why the replay could not read the request, which it then refuses. */
  unreadable?: string;
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
  body: string | Buffer;
}

/** The bucket and object a Storage path names, or null for a path that is not one. Throws a URIError for a bad `%` escape. */
export function storagePathOf(path: string): { bucket: string; object?: string } | null {
  const match = STORAGE_PATH.exec(path);
  if (!match) return null;
  const bucket = decodeURIComponent(match[1]!);
  return match[2] === undefined ? { bucket } : { bucket, object: decodeURIComponent(match[2]) };
}

/**
 * The upload protocol and command a request sent. A resumable chunk and its
 * `query` send only `X-Goog-Upload-Command`; the upload URL they go to names
 * the protocol (`upload_protocol=resumable`), so it is read there.
 */
export function uploadOf(protocol: string | undefined, command: string | undefined, query: JsonObject): { protocol: string; command?: string } | null {
  const fromUrl = command !== undefined && typeof query.upload_protocol === 'string' ? query.upload_protocol : undefined;
  const named = protocol ?? fromUrl;
  if (!named) return null;
  return command ? { protocol: named, command } : { protocol: named };
}

/** Reads one Storage call from its path, query, headers and raw body. */
export function readStorageRequest(state: ReplayState, method: string, path: string, query: URLSearchParams, headers: IncomingHttpHeaders, body: Buffer): StorageRequest | null {
  const raw = STORAGE_PATH.exec(path);
  if (!raw) return null;
  const token = /^Firebase (.+)$/.exec(headerOf(headers, 'authorization') ?? '')?.[1];
  // The raw bucket and object stand until they decode, so a refusal can name them.
  const request: StorageRequest = { method, bucket: raw[1]!, query: Object.fromEntries(query), as: state.tokens.uidOf(token) };
  if (raw[2] !== undefined) request.object = raw[2];
  try {
    Object.assign(request, storagePathOf(path));
  } catch {
    return { ...request, unreadable: 'its path has a bad % escape' };
  }
  const upload = uploadOf(headerOf(headers, 'x-goog-upload-protocol'), headerOf(headers, 'x-goog-upload-command'), request.query);
  if (upload) request.upload = upload;
  const offset = headerOf(headers, 'x-goog-upload-offset');
  if (offset !== undefined) Object.assign(request, { offset: Number(offset), chunk: body });
  try {
    Object.assign(request, sentContent(headerOf(headers, 'content-type') ?? '', body));
  } catch {
    request.unreadable = 'the metadata it sent is not JSON';
  }
  return request;
}

function headerOf(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value.join(', ') : value;
}

/** The metadata JSON and object bytes a body carries: a multipart upload's two parts, a JSON body, or a resumable chunk's bytes. */
function sentContent(contentType: string, body: Buffer): Pick<StorageRequest, 'metadata' | 'bytes'> {
  const boundary = /^multipart\/related;\s*boundary=(.+)$/i.exec(contentType)?.[1];
  if (boundary) return multipartContent(boundary, body);
  if (body.length === 0) return {};
  if (contentType.startsWith('application/json')) return { metadata: JSON.parse(body.toString('utf8')) as JsonObject };
  return { bytes: bytesOf(body) };
}

function bytesOf(content: Buffer): { length: number; sha256: string } {
  return { length: content.length, sha256: createHash('sha256').update(content).digest('hex') };
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
  return { metadata: JSON.parse(metadataPart.toString('utf8')) as JsonObject, bytes: bytesOf(bytesPart) };
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

/** An upload session this server opened: the bytes its chunks sent so far, and their MD5 so far. */
interface UploadSession {
  received: number;
  md5: Hash;
}

/** Storage state one replay server keeps: the calls it received, the objects it named, the upload sessions it opened. */
export class StorageReplay {
  readonly received: StorageReceived[] = [];
  private readonly objects = new Map<string, ObjectValues>();
  /** Each open upload session, by its id. */
  private readonly sessions = new Map<string, UploadSession>();
  private readonly used = new Set<string>();
  private lastGeneration = 0;

  constructor(private readonly state: ReplayState) {}

  /** The answer to one call. `origin` is the server's own, where an upload URL points. */
  answer(request: StorageRequest, origin: string): StorageAnswer {
    this.received.push({ rpc: 'storage', as: request.as, message: describe(request) });
    const refusal = request.unreadable ?? this.offsetRefusal(request);
    if (refusal) return this.refuse(request, refusal);
    const exchange = this.take(request);
    if (!exchange) return this.refuse(request);
    const contentRefusal = this.contentRefusal(exchange, request);
    if (contentRefusal) return this.refuse(request, contentRefusal);
    const headers = this.headersOf(exchange, request, origin);
    this.advanceSession(request);
    const { status, body } = exchange.response;
    if (isMedia(body, headers['content-type'])) return { status, headers, body: Buffer.from(String(body[MEDIA_KEY]), 'base64') };
    const object = request.object ?? stringOf(request.query.name);
    const filled = body === null ? null : fill(this.fillObject(body, request.bucket, object), this.state.context());
    const text = filled === null ? '' : typeof filled === 'string' ? filled : JSON.stringify(filled);
    return { status, headers, body: text };
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
    // A session's chunk is answered by its offset and command, which the session checks, not by its size.
    const isSessionChunk = this.sessionOf(request) !== undefined && request.offset !== undefined;
    const sameBytes = isSessionChunk || recorded.bytes === undefined || (recorded.bytes.length === request.bytes?.length && recorded.bytes.sha256 === request.bytes.sha256);
    return sameAccount && sameCall && sameUpload && sameMetadata && sameBytes && this.queryFits(recorded.query ?? {}, request.query);
  }

  /** The whole query matches, where `uploadSession` matches an upload session this server opened. */
  private queryFits(recorded: JsonObject, actual: JsonObject): boolean {
    const keys = Object.keys(recorded).sort();
    const sameKeys = keys.join('&') === Object.keys(actual).sort().join('&');
    return sameKeys && keys.every((key) => {
      const isSession = placeholderName(recorded[key]) === 'uploadSession';
      return isSession ? this.sessions.has(String(actual[key])) : matches(recorded[key], actual[key]);
    });
  }

  /** The answer's headers: an upload URL opens one session, and a `query` answers the bytes this server received. */
  private headersOf(exchange: StorageExchange, request: StorageRequest, origin: string): Record<string, string> {
    let uploadUrl: string | undefined;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(exchange.response.headers ?? {})) {
      const isSession = placeholderName(value) === 'uploadSession';
      if (isSession) uploadUrl ??= this.openSession(request, origin);
      headers[name] = isSession ? uploadUrl! : String(value);
    }
    const session = this.sessionOf(request);
    const isQuery = session !== undefined && request.upload?.command === 'query';
    if (isQuery) headers['x-goog-upload-size-received'] = String(this.sessions.get(session)!.received);
    return headers;
  }

  /** The id of the open session a request names, if it names one. */
  private sessionOf(request: StorageRequest): string | undefined {
    const id = stringOf(request.query.upload_id);
    return id !== undefined && this.sessions.has(id) ? id : undefined;
  }

  /** Why a chunk is refused: it names an offset other than the bytes its session received. */
  private offsetRefusal(request: StorageRequest): string | undefined {
    const session = this.sessionOf(request);
    const isChunk = session !== undefined && request.offset !== undefined && commandsOf(request).includes('upload');
    if (!isChunk) return undefined;
    const { received } = this.sessions.get(session)!;
    return request.offset === received ? undefined : `the chunk starts at ${String(request.offset)}, but its session received ${received} bytes`;
  }

  /**
   * Why a final chunk is refused: the bytes its session received, this chunk's
   * included, are not the object the recorded answer finalized, by the
   * `md5Hash` production answered with.
   */
  private contentRefusal(exchange: StorageExchange, request: StorageRequest): string | undefined {
    const session = this.sessionOf(request);
    const body = exchange.response.body;
    const recorded = typeof body === 'object' && body !== null && !Array.isArray(body) ? stringOf(body.md5Hash) : undefined;
    const isFinalChunk = session !== undefined && request.chunk !== undefined && commandsOf(request).includes('finalize');
    if (!isFinalChunk || recorded === undefined) return undefined;
    const received = this.sessions.get(session)!.md5.copy().update(request.chunk!).digest('base64');
    return received === recorded ? undefined : `the bytes its session received hash to md5 ${received}, but the object production finalized has md5Hash ${recorded}`;
  }

  /** Counts and hashes a chunk's bytes against its session, and closes the session it finalizes. */
  private advanceSession(request: StorageRequest): void {
    const session = this.sessionOf(request);
    if (session === undefined) return;
    const commands = commandsOf(request);
    const open = this.sessions.get(session)!;
    if (commands.includes('upload')) {
      open.received += request.bytes?.length ?? 0;
      if (request.chunk) open.md5.update(request.chunk);
    }
    if (commands.includes('finalize')) this.sessions.delete(session);
  }

  private refuse(request: StorageRequest, reason?: string): StorageAnswer {
    const object = request.object ?? stringOf(request.query.name) ?? '';
    const call = `${request.method} gs://${request.bucket}/${object}`;
    const message = reason ? `${NO_RECORDING}: the replay cannot answer ${call}: ${reason}` : `${NO_RECORDING}: no recorded Storage call answers ${call}`;
    this.state.unmatched.push({ rpc: 'http', as: request.as, request: { service: 'storage', ...describe(request) } });
    return { status: 400, headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ error: { code: 400, message } }) };
  }

  /** Opens an upload session and returns its upload URL on this server, what an `uploadSession` header is filled with. */
  private openSession(request: StorageRequest, origin: string): string {
    const id = `replay-upload-${randomUUID()}`;
    this.sessions.set(id, { received: 0, md5: createHash('md5') });
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

/** The commands an upload request sent, `upload, finalize` read as two. */
function commandsOf(request: StorageRequest): string[] {
  return (request.upload?.command ?? '').split(',').map((command) => command.trim());
}

/** True for an answer body that holds an object's bytes: `{ "$media": "<base64>" }` under a content type that is not JSON. */
function isMedia(body: Json, contentType: string | undefined): body is JsonObject {
  const isObject = typeof body === 'object' && body !== null && !Array.isArray(body);
  const isJson = (contentType ?? '').startsWith('application/json');
  return isObject && !isJson && typeof body[MEDIA_KEY] === 'string';
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
