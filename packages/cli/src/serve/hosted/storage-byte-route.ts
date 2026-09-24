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
    const object = await opts.storage.objectFile(bucket, path);
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

  async function receiveUpload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const sends = req.method === 'PUT';
    if (!sends) return refuse(res, 405, 'An upload sends its bytes with PUT.', { allow: 'PUT' });
    const uploadId = url.searchParams.get('upload_id') ?? '';
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
    const misplaced = start !== progress.received;
    if (misplaced) {
      req.resume();
      return refuse(res, 409, `The upload has received ${progress.received} bytes; send from there.`, receivedRange(progress));
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
      if (conflict) return refuse(res, 409, error.message, receivedRange({ received: error.received, size: progress.size }));
      return refuse(res, 400, error instanceof Error ? error.message : String(error));
    }
    return reportProgress(res, latest);
  }

  function reportProgress(res: ServerResponse, progress: UploadProgress): void {
    const complete = progress.received === progress.size;
    if (complete) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ bytesReceived: progress.received, size: progress.size }));
      return;
    }
    // Resume Incomplete, as a resumable Cloud Storage upload answers.
    res.writeHead(308, receivedRange(progress)).end();
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
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
  };
}
