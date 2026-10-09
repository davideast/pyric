/**
 * The Node host's HTTP byte route: object bytes move over plain HTTP while
 * rules and identity stay on the RPC.
 *
 *   GET  <prefix><bucket>/o/<path>?alt=media[&token=]   the object, or a Range of it
 *   PUT  <prefix><bucket>/o?name=&upload_id=&upload_token=   one upload's bytes
 *
 * A GET is authorized by the session token (header or `token`) or by a token in
 * the object's `downloadTokens`, as a Firebase download URL is. A PUT is
 * authorized only by the token bound to that one upload. An upload continues
 * from the offset the host holds, answered with `308` and `Range` until it is
 * complete; finishing it still commits over the RPC through the engine.
 *
 * An upload session, as firebase-admin's `File.createResumableUpload` begins
 * one, has no size until its bytes arrive: one `PUT` with `Content-Length`, or
 * `Content-Range` slices whose first one names the total. The session's object
 * is created when its last byte arrives, and the session answers its origin's
 * cross-origin requests.
 */
import { createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeTokenMatch, getHeader } from '../server.js';
import { STORAGE_ROUTE_PREFIX } from '../worker/protocol/storage.js';
import { UploadOffsetError, type ScopedStorageBackend, type UploadProgress } from './persistence/storage.js';

export interface StorageByteRouteOptions {
  storage: Pick<ScopedStorageBackend, 'objectFile' | 'appendUpload' | 'uploadProgress'>;
  /** The per-boot session token; undefined refuses every session-token request. */
  sessionToken: string | undefined;
  /** The token bound to a pending upload, or undefined when there is none. */
  uploadToken(uploadId: string): string | undefined;
  /** The bucket an object URL's bucket name stores its objects in. Absent, the name itself. */
  bucketOf?(name: string): string;
  /** Upload sessions, which this route commits when their last byte arrives. */
  sessions?: UploadSessions;
}

/** A pending upload session, as the route sees it. */
export interface UploadSessionView {
  /** Authorizes sending this session's bytes, and nothing else. */
  token: string;
  /** The page origin whose cross-origin requests the session answers. */
  origin?: string;
  /** The upload holding the session's bytes, once its size is known. */
  uploadId?: string;
}

export interface UploadSessions {
  get(sessionId: string): UploadSessionView | undefined;
  /** Begin the upload that holds the session's `size` bytes; resolves its upload id. */
  open(sessionId: string, size: number): Promise<string>;
  /** Create the session's object from its complete upload; resolves the object's metadata. */
  finish(sessionId: string): Promise<unknown>;
}

type Target = { kind: 'object'; bucket: string; path: string } | { kind: 'upload'; bucket: string };

/** Where a byte route path points, or undefined when it is not one. */
function targetOf(pathname: string): Target | undefined {
  const rest = pathname.slice(STORAGE_ROUTE_PREFIX.length);
  const slash = rest.indexOf('/');
  const malformed = slash <= 0;
  if (malformed) return undefined;
  const bucket = decodeURIComponent(rest.slice(0, slash));
  const tail = rest.slice(slash + 1);
  const isUpload = tail === 'o';
  if (isUpload) return { kind: 'upload', bucket };
  const isObject = tail.startsWith('o/') && tail.length > 2;
  if (!isObject) return undefined;
  return { kind: 'object', bucket, path: decodeURIComponent(tail.slice(2)) };
}

function refuse(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }).end(message);
}

/** `bytes=a-b`, `bytes=a-`, or `bytes=-n` over an object of `size` bytes. */
function rangeOf(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  const noRange = match === null;
  if (noRange) return undefined;
  const [, first, last] = match;
  const suffix = first === '' && last !== '';
  if (suffix) {
    const length = Math.min(Number(last), size);
    return length === 0 ? 'unsatisfiable' : { start: size - length, end: size - 1 };
  }
  const invalid = first === '';
  if (invalid) return undefined;
  const start = Number(first);
  const pastEnd = start >= size;
  if (pastEnd) return 'unsatisfiable';
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  const backwards = end < start;
  if (backwards) return undefined;
  return { start, end };
}

/** The range an upload has received, as a `Range` header, or nothing when it has none. */
function receivedRange(progress: UploadProgress): Record<string, string> {
  const hasBytes = progress.received > 0;
  return hasBytes ? { range: `bytes=0-${progress.received - 1}` } : {};
}

export function createStorageByteRoute(opts: StorageByteRouteOptions) {
  const presentsSession = (req: IncomingMessage, url: URL): boolean =>
    timingSafeTokenMatch(getHeader(req, 'x-pyric-session-token') ?? url.searchParams.get('token') ?? undefined, opts.sessionToken);

  async function serveObject(req: IncomingMessage, res: ServerResponse, url: URL, bucket: string, path: string): Promise<void> {
    const reads = req.method === 'GET' || req.method === 'HEAD';
    if (!reads) return refuse(res, 405, 'An object is read with GET.', { allow: 'GET, HEAD' });
    const object = await opts.storage.objectFile(opts.bucketOf?.(bucket) ?? bucket, path);
    const missing = object === undefined;
    if (missing) return refuse(res, 404, 'No such object.');
    const presented = url.searchParams.get('token') ?? undefined;
    const downloadTokens = (object.metadata.downloadTokens ?? '').split(',').filter(token => token !== '');
    const byDownloadToken = downloadTokens.some(token => timingSafeTokenMatch(presented, token));
    const authorized = presentsSession(req, url) || byDownloadToken;
    if (!authorized) return refuse(res, 403, 'This URL carries no token that grants this object.');
    // A client that checked read rules on one generation asks for exactly that one.
    const pinned = url.searchParams.get('generation');
    const changed = pinned !== null && pinned !== object.metadata.generation;
    if (changed) return refuse(res, 412, 'The object changed since its rules were checked. Read its metadata and retry.');
    const headers: Record<string, string> = {
      'content-type': object.mime || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': object.metadata.cacheControl ?? 'no-store',
    };
    const disposition = object.metadata.contentDisposition;
    if (disposition !== undefined) headers['content-disposition'] = disposition;
    const range = rangeOf(getHeader(req, 'range'), object.size);
    const unsatisfiable = range === 'unsatisfiable';
    if (unsatisfiable) return refuse(res, 416, 'The range is past the end of the object.', { 'content-range': `bytes */${object.size}` });
    const partial = range !== undefined;
    const start = partial ? range.start : 0;
    const end = partial ? range.end : object.size - 1;
    const length = object.size === 0 ? 0 : end - start + 1;
    if (partial) headers['content-range'] = `bytes ${start}-${end}/${object.size}`;
    headers['content-length'] = String(length);
    res.writeHead(partial ? 206 : 200, headers);
    const headOnly = req.method === 'HEAD' || length === 0;
    if (headOnly) {
      res.end();
      return;
    }
    const stream = createReadStream(object.file, { start, end });
    res.on('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  /**
   * Append the request body to an upload from `start`, which must be what the
   * upload has received. Resolves the upload's progress after the body, or
   * undefined once it has answered the request with a refusal.
   */
  async function appendBody(
    req: IncomingMessage,
    res: ServerResponse,
    uploadId: string,
    start: number,
    progress: UploadProgress,
    headers: Record<string, string>,
  ): Promise<UploadProgress | undefined> {
    const misplaced = start !== progress.received;
    if (misplaced) {
      req.resume();
      refuse(res, 409, `The upload has received ${progress.received} bytes; send from there.`, { ...headers, ...receivedRange(progress) });
      return undefined;
    }
    let offset = start;
    let latest = progress;
    try {
      for await (const chunk of req as AsyncIterable<Buffer>) {
        latest = await opts.storage.appendUpload(uploadId, offset, new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        offset += chunk.byteLength;
      }
    } catch (error) {
      req.resume();
      const conflict = error instanceof UploadOffsetError;
      if (conflict) refuse(res, 409, error.message, { ...headers, ...receivedRange({ received: error.received, size: progress.size }) });
      else refuse(res, 400, error instanceof Error ? error.message : String(error), headers);
      return undefined;
    }
    return latest;
  }

  async function receiveUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const uploadId = url.searchParams.get('upload_id') ?? '';
    const session = opts.sessions?.get(uploadId);
    const isSession = session !== undefined;
    if (isSession) return receiveSession(req, res, url, uploadId, session);
    const sends = req.method === 'PUT';
    if (!sends) return refuse(res, 405, 'An upload sends its bytes with PUT.', { allow: 'PUT' });
    const bound = opts.uploadToken(uploadId);
    const authorized = bound !== undefined && timingSafeTokenMatch(url.searchParams.get('upload_token') ?? undefined, bound);
    if (!authorized) {
      req.resume();
      return refuse(res, 403, 'This URL carries no token for this upload.');
    }
    const progress = await opts.storage.uploadProgress(uploadId);
    const unknownUpload = progress === undefined;
    if (unknownUpload) {
      req.resume();
      return refuse(res, 404, 'No such upload.');
    }
    // `bytes a-b/total` sends bytes; `bytes */total` asks what the host holds.
    const contentRange = getHeader(req, 'content-range');
    const sending = contentRange === undefined ? { start: 0 } : /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange.trim());
    const asking = contentRange !== undefined && /^bytes \*\/(\d+|\*)$/.test(contentRange.trim());
    if (asking) {
      req.resume();
      return reportProgress(res, progress);
    }
    const unreadable = sending === null;
    if (unreadable) {
      req.resume();
      return refuse(res, 400, 'Content-Range must be "bytes a-b/total" or "bytes */total".');
    }
    const start = Array.isArray(sending) ? Number(sending[1]) : sending.start;
    const latest = await appendBody(req, res, uploadId, start, progress, {});
    const refused = latest === undefined;
    if (refused) return;
    return reportProgress(res, latest);
  }

  /** CORS headers for the session's origin, when the request comes from it. */
  function corsFor(req: IncomingMessage, session: UploadSessionView): Record<string, string> {
    const origin = getHeader(req, 'origin');
    const fromSessionOrigin = session.origin !== undefined && origin === session.origin;
    if (!fromSessionOrigin) return {};
    return { 'access-control-allow-origin': origin!, 'access-control-expose-headers': 'range', vary: 'origin' };
  }

  async function receiveSession(req: IncomingMessage, res: ServerResponse, url: URL, sessionId: string, session: UploadSessionView): Promise<void> {
    const authorized = timingSafeTokenMatch(url.searchParams.get('upload_token') ?? undefined, session.token);
    const cors = authorized ? corsFor(req, session) : {};
    const preflight = req.method === 'OPTIONS';
    if (preflight) {
      req.resume();
      const allowed = Object.keys(cors).length > 0;
      if (!allowed) return refuse(res, 403, 'This upload session does not answer requests from this origin.');
      const requested = getHeader(req, 'access-control-request-headers');
      res.writeHead(204, {
        ...cors,
        'access-control-allow-methods': 'PUT',
        ...(requested !== undefined ? { 'access-control-allow-headers': requested } : {}),
        'access-control-max-age': '3600',
      }).end();
      return;
    }
    const sends = req.method === 'PUT';
    if (!sends) {
      req.resume();
      return refuse(res, 405, 'An upload session takes its bytes with PUT.', { ...cors, allow: 'PUT, OPTIONS' });
    }
    if (!authorized) {
      req.resume();
      return refuse(res, 403, 'This URL carries no token for this upload.');
    }
    // No Content-Range sends the whole object; `bytes a-b/total` sends a
    // slice; `bytes */total` asks what the host holds.
    const contentRange = getHeader(req, 'content-range')?.trim();
    const asking = contentRange !== undefined && /^bytes \*\/(\d+|\*)$/.test(contentRange);
    const slice = contentRange === undefined ? undefined : /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
    const unreadable = contentRange !== undefined && !asking && slice === null;
    if (unreadable) {
      req.resume();
      return refuse(res, 400, 'Content-Range must be "bytes a-b/total" or "bytes */total".', cors);
    }
    let uploadId = session.uploadId;
    const opened = uploadId !== undefined;
    if (asking) {
      req.resume();
      const progress = opened ? await opts.storage.uploadProgress(uploadId!) : undefined;
      // Nothing received yet: Resume Incomplete with no Range.
      return reportProgress(res, progress ?? { received: 0, size: Number.POSITIVE_INFINITY }, cors);
    }
    const whole = slice === undefined || slice === null;
    const total = whole ? undefined : slice[3];
    if (!opened) {
      // The session's size: the whole body's length, or the total the first slice names.
      const declared = whole ? getHeader(req, 'content-length') : total;
      const size = declared === undefined || declared === '*' ? Number.NaN : Number(declared);
      const sized = Number.isSafeInteger(size) && size >= 0;
      if (!sized) {
        req.resume();
        const message = whole
          ? 'Send the object in one PUT with Content-Length, or in Content-Range slices whose first one names the total size.'
          : 'The first Content-Range of an upload session must name the total size ("bytes a-b/total"). This sandbox does not take an unknown total.';
        return refuse(res, whole ? 411 : 400, message, cors);
      }
      try {
        uploadId = await opts.sessions!.open(sessionId, size);
      } catch (error) {
        req.resume();
        return refuse(res, 400, error instanceof Error ? error.message : String(error), cors);
      }
    }
    const progress = await opts.storage.uploadProgress(uploadId!);
    const lost = progress === undefined;
    if (lost) {
      req.resume();
      return refuse(res, 404, 'No such upload.', cors);
    }
    const contradicts = total !== undefined && total !== '*' && Number(total) !== progress.size;
    if (contradicts) {
      req.resume();
      return refuse(res, 400, `The upload session holds an object of ${progress.size} bytes; Content-Range names ${total}.`, cors);
    }
    const start = whole ? 0 : Number(slice[1]);
    const latest = await appendBody(req, res, uploadId!, start, progress, cors);
    const refused = latest === undefined;
    if (refused) return;
    const complete = latest.received === latest.size;
    if (!complete) return reportProgress(res, latest, cors);
    try {
      const metadata = await opts.sessions!.finish(sessionId);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(metadata));
    } catch (error) {
      refuse(res, 500, error instanceof Error ? error.message : String(error), cors);
    }
  }

  function reportProgress(res: ServerResponse, progress: UploadProgress, headers: Record<string, string> = {}): void {
    const complete = progress.received === progress.size;
    if (complete) {
      res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify({ bytesReceived: progress.received, size: progress.size }));
      return;
    }
    // Resume Incomplete, as a resumable Cloud Storage upload answers.
    res.writeHead(308, { ...headers, ...receivedRange(progress) }).end();
  }

  /** Whether `origin` may reach `url`: an upload session's URL, with its token, from the session's origin. */
  function allowsOrigin(url: URL, origin: string | undefined): boolean {
    const target = targetOf(url.pathname);
    const isUpload = target?.kind === 'upload';
    if (!isUpload || origin === undefined) return false;
    const session = opts.sessions?.get(url.searchParams.get('upload_id') ?? '');
    const fromSessionOrigin = session !== undefined && session.origin === origin;
    return fromSessionOrigin && timingSafeTokenMatch(url.searchParams.get('upload_token') ?? undefined, session.token);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const onRoute = url.pathname.startsWith(STORAGE_ROUTE_PREFIX);
    if (!onRoute) return false;
    const target = targetOf(url.pathname);
    const unknownPath = target === undefined;
    if (unknownPath) {
      refuse(res, 404, 'Not a byte route path.');
      return true;
    }
    if (target.kind === 'object') await serveObject(req, res, url, target.bucket, target.path);
    else await receiveUpload(req, res, url);
    return true;
  }

  return Object.assign(handle, { allowsOrigin });
}
