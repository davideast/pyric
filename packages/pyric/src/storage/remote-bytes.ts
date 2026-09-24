/**
 * Storage bytes between a Node process and a hosted sandbox's HTTP byte route.
 *
 * Rules and the commit stay on the relay channel's RPC; the bytes move over
 * HTTP. Uploads begin over the RPC, which returns the upload's own URL, send
 * the object in slices with `Content-Range`, and finish over the RPC. Reads
 * are a `GET` with the session token, optionally for a byte range.
 */

/** How a remote client reaches its host's byte route. */
export interface RemoteByteRoute {
  /** The host's HTTP origin. */
  baseUrl: string;
  /** The host's session token, which authorizes this process's reads. */
  sessionToken(): Promise<string | null>;
}

/** The channel operations an upload needs. */
interface OperationChannel {
  op(op: { method: string } & Record<string, unknown>): Promise<unknown>;
}

const SLICE_BYTES = 4 * 1024 * 1024;
const ROUTE_PREFIX = '/__pyric/storage/v0/b/';

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function routeFailure(status: number, path: string): Error & { code: string } {
  const refused = status === 401 || status === 403;
  if (refused) return failure('storage/unauthorized', `The host refused bytes for '${path}' (HTTP ${status}).`);
  const missing = status === 404;
  if (missing) return failure('storage/object-not-found', `Object '${path}' does not exist.`);
  return failure('storage/unknown', `The host's byte route answered HTTP ${status} for '${path}'.`);
}

/** How many bytes a byte route answer says the host holds. */
function receivedFrom(response: Response, size: number): number {
  const complete = response.status === 200;
  if (complete) return size;
  const held = /^bytes=0-(\d+)$/.exec(response.headers.get('range') ?? '');
  return held === null ? 0 : Number(held[1]) + 1;
}

export interface RemoteUploadRequest {
  path: string;
  data: Blob;
  contentType?: string;
  metadata?: Record<string, unknown>;
  actAs?: unknown;
}

/** Upload over the byte route; resolves with the object's metadata from `finishUpload`. */
export async function uploadOverByteRoute(channel: OperationChannel, route: RemoteByteRoute, request: RemoteUploadRequest): Promise<unknown> {
  const { path, data, contentType, metadata, actAs } = request;
  const begun = (await channel.op({
    method: 'storage.beginUpload',
    path,
    size: data.size,
    ...(contentType !== undefined ? { contentType } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
    ...(actAs !== undefined ? { actAs } : {}),
  })) as { uploadId: string; uploadUrl?: string };
  const uploadUrl = begun.uploadUrl;
  const unrouted = uploadUrl === undefined;
  if (unrouted) throw failure('storage/unknown', 'The host began the upload without a byte route URL.');
  const url = new URL(uploadUrl, route.baseUrl).href;
  const finish = { method: 'storage.finishUpload', uploadId: begun.uploadId, ...(actAs !== undefined ? { actAs } : {}) };
  try {
    let offset = 0;
    while (offset < data.size) {
      const end = Math.min(offset + SLICE_BYTES, data.size);
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'content-range': `bytes ${offset}-${end - 1}/${data.size}` },
        body: data.slice(offset, end),
      });
      const accepted = response.status === 200 || response.status === 308 || response.status === 409;
      if (!accepted) throw routeFailure(response.status, path);
      offset = receivedFrom(response, data.size);
    }
    return await channel.op(finish);
  } catch (error) {
    try {
      await channel.op({ method: 'storage.abortUpload', uploadId: begun.uploadId, ...(actAs !== undefined ? { actAs } : {}) });
    } catch {
      // The host discards staging a stopped host left, too.
    }
    throw error;
  }
}

export interface RemoteReadRequest {
  bucket: string;
  path: string;
  /** First byte, inclusive. */
  start?: number;
  /** Last byte, inclusive. */
  end?: number;
  /** Refuse bytes of any other generation. */
  generation?: string;
}

/** A `GET` of an object, or a range of it, over the byte route. Throws unless the response carries bytes. */
export async function fetchFromByteRoute(route: RemoteByteRoute, request: RemoteReadRequest): Promise<Response> {
  const token = await route.sessionToken();
  const missingToken = token === null || token === '';
  if (missingToken) throw failure('unavailable', 'The host gave no session token for its byte route.');
  const url = new URL(`${ROUTE_PREFIX}${encodeURIComponent(request.bucket)}/o/${encodeURIComponent(request.path)}`, route.baseUrl);
  url.searchParams.set('alt', 'media');
  const generation = request.generation;
  if (generation !== undefined) url.searchParams.set('generation', generation);
  const headers: Record<string, string> = { 'x-pyric-session-token': token };
  const ranged = request.start !== undefined || request.end !== undefined;
  if (ranged) headers.range = `bytes=${request.start ?? 0}-${request.end ?? ''}`;
  const response = await fetch(url, { headers });
  const pastEnd = response.status === 416;
  if (pastEnd) return new Response(new Uint8Array(0), { status: 206 });
  if (!response.ok) throw routeFailure(response.status, request.path);
  return response;
}
