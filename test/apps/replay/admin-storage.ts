// The Cloud Storage JSON API calls the Admin SDK (`firebase-admin/storage`,
// through `@google-cloud/storage`) sends, answered from `admin-storage`
// exchanges. With `STORAGE_EMULATOR_HOST` set to this server's origin, the
// SDK sends no credential and drops the `/storage/v1` prefix from object
// calls: `GET /b/<bucket>/o/<object>` (getMetadata, exists, and download
// with `alt=media`), `GET /b/<bucket>/o` (getFiles), `PATCH` (setMetadata)
// and `DELETE` on an object, and `POST /upload/storage/v1/b/<bucket>/o` with
// `uploadType=multipart` or `uploadType=resumable` (save). A resumable start
// answers a `location` header; its PUT goes there with the bytes.
//
// A call matches an exchange when its method, raw path (the object name
// percent-encoded as the SDK sends it), whole query, JSON metadata and
// object bytes match the recorded ones, with placeholders. In an answer
// header, `{ "$": "uploadSession" }` opens an upload session and is filled
// with its URL on this server; in a request query it matches a session this
// server opened, which its answer closes. An answer body `{ "$media":
// "<base64>" }` under a content type that is not JSON is an object's bytes.
// The first matching exchange not yet used answers, or the last matching one
// when all are used.
//
// Fails closed: a call no exchange answers gets a 400 the SDK does not retry
// (it retries 408, 429 and 5xx) and is listed in `unmatched`.
//
// Not covered, as no recording holds them yet: a resumable upload in more
// than one chunk, and server-picked values (generation, etag, timeCreated)
// as placeholders; the fixture holds fixed test values.
import { createHash, randomUUID } from 'node:crypto';
import type { Json, JsonObject } from './format.ts';
import { placeholderName } from './format.ts';
import type { ReplayState } from './firestore.ts';
import { MEDIA_KEY, NO_RECORDING, type StorageReceived } from './storage.ts';
import { matches } from './values.ts';

/** A JSON API path: an object call under the emulator origin, or an upload. */
const ADMIN_STORAGE_PATH = /^\/(?:upload\/storage\/v1\/|storage\/v1\/)?b\/([^/]+)\/o(?:\/[^/]+)?$/;

/** One JSON API call the Admin SDK sent and production's answer. */
export interface AdminStorageExchange {
  kind: 'admin-storage';
  id: string;
  request: {
    method: string;
    /** The raw path, as the SDK sends it: `/b/<bucket>/o/notes%2Fa.txt`. */
    path: string;
    query?: JsonObject;
    /** The JSON the call sent: a multipart upload's first part, a resumable start or a PATCH body. */
    metadata?: JsonObject;
    /** The length and SHA-256 of the object bytes an upload sent. */
    bytes?: { length: number; sha256: string };
  };
  response: { status: number; headers?: JsonObject; body: Json };
}

export interface AdminStorageRequest {
  method: string;
  path: string;
  query: JsonObject;
  contentType: string;
  body: Buffer;
}

interface SentContent {
  metadata?: JsonObject;
  bytes?: { length: number; sha256: string };
}

/** Whether a path is a JSON API object, list or upload call. */
export function isAdminStoragePath(path: string): boolean {
  return ADMIN_STORAGE_PATH.test(path);
}

export class AdminStorage {
  private readonly used = new Set<string>();
  /** Upload sessions this server opened and has not closed. */
  private readonly sessions = new Set<string>();

  constructor(private readonly state: ReplayState, private readonly received: StorageReceived[]) {}

  /** The answer to one call. `origin` is the server's own, where an upload URL points. */
  answer(request: AdminStorageRequest, origin: string): { status: number; headers: Record<string, string>; body: string | Buffer } {
    const logged: JsonObject = { service: 'admin-storage', method: request.method, path: request.path, query: request.query };
    this.received.push({ rpc: 'storage', as: null, message: logged });
    const sent = sentContent(request.contentType, request.body);
    const exchange = sent ? this.take(request, sent) : null;
    if (!exchange) {
      this.state.unmatched.push({ rpc: 'http', as: null, request: logged });
      const message = `${NO_RECORDING}: no recorded Storage call answers ${request.method} ${request.path}`;
      return { status: 400, headers: { 'content-type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ error: { code: 400, message } }) };
    }
    const session = request.query.upload_id;
    if (typeof session === 'string') this.sessions.delete(session);
    const headers = this.headersOf(exchange, request, origin);
    const { status, body } = exchange.response;
    const isMedia = typeof body === 'object' && body !== null && !Array.isArray(body) && typeof body[MEDIA_KEY] === 'string' && !(headers['content-type'] ?? '').startsWith('application/json');
    if (isMedia) return { status, headers, body: Buffer.from(String((body as JsonObject)[MEDIA_KEY]), 'base64') };
    return { status, headers, body: body === null ? '' : JSON.stringify(body) };
  }

  private take(request: AdminStorageRequest, sent: SentContent): AdminStorageExchange | null {
    const candidates = this.state.recordings
      .flatMap((recording) => recording.exchanges as Array<{ kind: string }>)
      .filter((exchange): exchange is AdminStorageExchange => exchange.kind === 'admin-storage' && this.fits(exchange as AdminStorageExchange, request, sent));
    const chosen = candidates.find((exchange) => !this.used.has(exchange.id)) ?? candidates.at(-1) ?? null;
    if (chosen) this.used.add(chosen.id);
    return chosen;
  }

  private fits(exchange: AdminStorageExchange, request: AdminStorageRequest, sent: SentContent): boolean {
    const recorded = exchange.request;
    const sameCall = recorded.method === request.method && recorded.path === request.path;
    const sameMetadata = recorded.metadata === undefined || matches(recorded.metadata, sent.metadata);
    const sameBytes = recorded.bytes === undefined || (recorded.bytes.length === sent.bytes?.length && recorded.bytes.sha256 === sent.bytes.sha256);
    return sameCall && sameMetadata && sameBytes && this.queryFits(recorded.query ?? {}, request.query);
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

  /** The answer's headers, where an `uploadSession` header opens a session and names its URL. */
  private headersOf(exchange: AdminStorageExchange, request: AdminStorageRequest, origin: string): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(exchange.response.headers ?? {})) {
      const isSession = placeholderName(value) === 'uploadSession';
      headers[name] = isSession ? this.openSession(request, origin) : String(value);
    }
    return headers;
  }

  private openSession(request: AdminStorageRequest, origin: string): string {
    const id = `replay-upload-${randomUUID()}`;
    this.sessions.add(id);
    const query = new URLSearchParams({ uploadType: 'resumable', name: String(request.query.name ?? ''), upload_id: id });
    return `${origin}${request.path}?${query}`;
  }
}

/**
 * The metadata JSON and object bytes a body carries: a multipart upload's two
 * parts, a JSON body, or raw bytes. Null for metadata that is not JSON.
 */
function sentContent(contentType: string, body: Buffer): SentContent | null {
  try {
    const boundary = /^multipart\/related;\s*boundary=(.+)$/i.exec(contentType)?.[1];
    if (boundary) return multipartContent(boundary, body);
    if (body.length === 0) return {};
    if (contentType.startsWith('application/json')) return { metadata: JSON.parse(body.toString('utf8')) as JsonObject };
    return { bytes: bytesOf(body) };
  } catch {
    return null;
  }
}

/** The SDK's multipart body: `--<boundary>`, the metadata part, `--<boundary>`, the bytes part, `--<boundary>--`. */
function multipartContent(boundary: string, body: Buffer): SentContent {
  const delimiter = `--${boundary}`;
  const parts = body.toString('latin1').split(delimiter).slice(1, -1).map((part) => {
    const content = part.slice(part.indexOf('\r\n\r\n') + 4);
    return Buffer.from(content.endsWith('\r\n') ? content.slice(0, -2) : content, 'latin1');
  });
  const [metadata, bytes] = parts;
  if (metadata === undefined || bytes === undefined) return {};
  return { metadata: JSON.parse(metadata.toString('utf8')) as JsonObject, bytes: bytesOf(bytes) };
}

function bytesOf(content: Buffer): { length: number; sha256: string } {
  return { length: content.length, sha256: createHash('sha256').update(content).digest('hex') };
}
