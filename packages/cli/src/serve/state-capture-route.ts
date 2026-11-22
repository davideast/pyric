import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { answerAndClose, collectBody, isBodyTooLarge } from '../bridge/server/peer.js';
import { StateFileError, type StateSection, type StateStore } from './state-store.js';
import {
  parseStateVersionHeader,
  STATE_VERSION_HEADER,
  type WriterLock,
} from './writer-lock.js';

/** The page's persistence backend speaks this route:
 *  GET    /__pyric/state                    -> whole envelope (404 when absent)
 *  GET    /__pyric/state?section=firestore  -> that section (404 when null)
 *  PUT    /__pyric/state                    -> claim/refresh the writer lock
 *  POST   /__pyric/state?section=...        -> write the section (204; 423 if
 *                                             another tab holds the writer lock;
 *                                             409 if x-pyric-state-version is stale)
 *  DELETE /__pyric/state                    -> release the writer lock (beacon)
 *  Writes carry `x-pyric-writer: <id>` and `x-pyric-state-version: <n>`; the
 *  first writer wins, and any writer with an outdated state version gets 409
 *  and drops to read-only (#2051). The firestore body is the sandbox
 *  persistence controller's own blob -- stored verbatim, never interpreted. */
export const STATE_OBJECTS_PREFIX = '/__pyric/state/objects/';
export const STATE_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * GET /__pyric/state/objects/<sha256> -> the bytes a Storage reference in the
 * state document names. Only a store that keeps object bytes in files serves them.
 */
export function handleStateObject(
  state: StateStore,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const isRead = req.method === 'GET';
  const unsupportedMethod = !isRead;
  if (unsupportedMethod) {
    answerAndClose(req, res, 405, { allow: 'GET' }, 'method not allowed');
    return;
  }
  const sha256 = url.pathname.slice(STATE_OBJECTS_PREFIX.length);
  const invalidHash = !/^[0-9a-f]{64}$/.test(sha256);
  if (invalidHash) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end(
      'An object is named by its SHA-256, as 64 lowercase hex characters.',
    );
    return;
  }
  const file = state.objectFile?.(sha256);
  const missing = file === undefined;
  if (missing) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('No object has that hash.');
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(statSync(file).size),
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
}

function readExpectedStateVersion(
  req: IncomingMessage,
): number | undefined | 'invalid' {
  const rawHeader = req.headers[STATE_VERSION_HEADER];
  const headerValue = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  return parseStateVersionHeader(headerValue);
}

function hasUnreadRequestBody(req: IncomingMessage): boolean {
  if (req.complete || req.readableEnded) return false;
  const contentLength = req.headers['content-length'];
  const hasNonZeroLength = contentLength !== undefined && contentLength !== '0';
  const hasTransferEncoding = req.headers['transfer-encoding'] !== undefined;
  return hasNonZeroLength || hasTransferEncoding;
}

export async function handleState(
  state: StateStore,
  lock: WriterLock,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: { isRemoteRequest?: boolean } = {},
): Promise<void> {
  const section = url.searchParams.get('section');
  const writerId = (req.headers['x-pyric-writer'] as string | undefined) ?? '';
  const effectiveWriter = writerId || 'anon';
  try {
    if (req.method === 'GET') {
      let value: unknown;
      if (section) {
        value = state.readSection(section as StateSection);
      } else {
        value = state.load();
      }
      const currentVersion = String(lock.version());
      if (value === null) {
        res.writeHead(404, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          [STATE_VERSION_HEADER]: currentVersion,
        }).end('null');
        return;
      }
      const responseHeaders: Record<string, string> = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        [STATE_VERSION_HEADER]: currentVersion,
      };
      if (options.isRemoteRequest !== true) {
        responseHeaders['x-pyric-project-dir'] = state.projectDir;
      }
      res.writeHead(200, responseHeaders);
      res.end(JSON.stringify(value));
      return;
    }
    if (req.method === 'DELETE') {
      if (writerId) lock.release(writerId);
      if (hasUnreadRequestBody(req)) {
        answerAndClose(req, res, 204, {}, '');
        return;
      }
      res.writeHead(204).end();
      return;
    }
    const expectedVersion = readExpectedStateVersion(req);
    if (expectedVersion === 'invalid') {
      answerAndClose(
        req,
        res,
        400,
        { 'content-type': 'text/plain' },
        `${STATE_VERSION_HEADER} must be a non-negative integer`,
      );
      return;
    }
    const refuseOutdatedVersion = (): boolean => {
      const isOutdated =
        expectedVersion !== undefined && expectedVersion !== lock.version();
      if (!isOutdated) return false;
      if (writerId && lock.holder() === writerId) {
        lock.release(writerId);
      }
      answerAndClose(
        req,
        res,
        409,
        {
          'content-type': 'text/plain',
          [STATE_VERSION_HEADER]: String(lock.version()),
        },
        `saved state is at version ${lock.version()}, expected ${expectedVersion}`,
      );
      return true;
    };
    if (req.method === 'PUT') {
      if (refuseOutdatedVersion()) return;
      const claimed = lock.claim(effectiveWriter, Date.now(), expectedVersion);
      const status = claimed ? 204 : 423;
      const versionHeaders = { [STATE_VERSION_HEADER]: String(lock.version()) };
      if (!claimed || hasUnreadRequestBody(req)) {
        answerAndClose(req, res, status, versionHeaders, '');
        return;
      }
      res.writeHead(status, versionHeaders).end();
      return;
    }
    if (req.method === 'POST') {
      if (section !== 'firestore' && section !== 'auth') {
        answerAndClose(req, res, 400, { 'content-type': 'text/plain' }, 'section must be firestore|auth');
        return;
      }
      if (refuseOutdatedVersion()) return;
      if (!lock.claim(effectiveWriter, Date.now(), expectedVersion)) {
        answerAndClose(
          req,
          res,
          423,
          {
            'content-type': 'text/plain',
            [STATE_VERSION_HEADER]: String(lock.version()),
          },
          `another tab holds the persist writer lock (held by ${lock.holder()})`,
        );
        return;
      }
      const body = await collectBody(req, STATE_BODY_LIMIT_BYTES);
      if (refuseOutdatedVersion()) return;
      if (!lock.claim(effectiveWriter, Date.now(), expectedVersion)) {
        res.writeHead(423, {
          'content-type': 'text/plain',
          [STATE_VERSION_HEADER]: String(lock.version()),
        }).end(
          `another tab holds the persist writer lock (held by ${lock.holder()})`,
        );
        return;
      }
      await state.writeSection(section, body);
      const nextVersion = lock.advanceVersion();
      res.writeHead(204, {
        [STATE_VERSION_HEADER]: String(nextVersion),
      }).end();
      return;
    }
    answerAndClose(req, res, 405, { allow: 'GET, PUT, POST, DELETE' }, 'method not allowed');
  } catch (e) {
    if (isBodyTooLarge(e)) {
      answerAndClose(req, res, 413, { 'content-type': 'text/plain' }, 'Payload Too Large');
      return;
    }
    const status = e instanceof StateFileError ? 409 : 400;
    res.writeHead(status, { 'content-type': 'text/plain' });
    const message = e instanceof Error ? e.message : String(e);
    res.end(message);
  }
}

/**
 * Handle POST /__pyric/capture -- the page pushes its full session fixture
 * (JSON-serialized history + snapshot + rules) whenever the sandbox changes.
 * The server writes it verbatim to `.pyric/last-session.json` so
 * `pyric verify` can pick it up without any extra arguments. When a clearing
 * flush (`events: []`) overwrites a non-empty capture, the store preserves the
 * prior capture at `.pyric/previous-session.json` first.
 *
 * GET returns the current fixture JSON verbatim (200), or 404 when nothing
 * has been captured yet. The served SharedWorker fetches this on boot to
 * re-hydrate its in-memory event history after a worker death (Traffic /
 * activity / metrics survive the refresh even though the worker restarted).
 * Cheap + read-only.
 */
export async function handleCapture(
  capture: { write(json: string): void; read(): string | null },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method === 'GET') {
    const body = capture.read();
    if (body === null) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('null');
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }
  if (req.method !== 'POST') {
    answerAndClose(req, res, 405, { allow: 'GET, POST' }, 'method not allowed');
    return;
  }
  try {
    const body = await new Promise<string>((resolve, reject) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        raw += chunk;
      });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
    capture.write(body);
    res.writeHead(204).end();
  } catch (e) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    const message = e instanceof Error ? e.message : String(e);
    res.end(message);
  }
}
