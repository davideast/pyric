import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { collectBody } from '../bridge/server/peer.js';
import { StateFileError, type StateSection, type StateStore } from './state-store.js';
import type { WriterLock } from './writer-lock.js';

/** The page's persistence backend speaks this route:
 *  GET    /__pyric/state                    -> whole envelope (404 when absent)
 *  GET    /__pyric/state?section=firestore  -> that section (404 when null)
 *  POST   /__pyric/state?section=...        -> write the section (204; 423 if
 *                                             another tab holds the writer lock)
 *  DELETE /__pyric/state                    -> release the writer lock (beacon)
 *  Writes carry `x-pyric-writer: <id>`; the first writer wins, others get 423
 *  and drop to read-only (pre-mortem #3). The firestore body is the sandbox
 *  persistence controller's own blob -- stored verbatim, never interpreted. */
export const STATE_OBJECTS_PREFIX = '/__pyric/state/objects/';

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
    res.writeHead(405, { allow: 'GET' }).end('method not allowed');
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

export async function handleState(
  state: StateStore,
  lock: WriterLock,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const section = url.searchParams.get('section');
  const writerId = (req.headers['x-pyric-writer'] as string | undefined) ?? '';
  try {
    if (req.method === 'GET') {
      let value: unknown;
      if (section) {
        value = state.readSection(section as StateSection);
      } else {
        value = state.load();
      }
      if (value === null) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('null');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        // Lets `pyric snapshot` detect it scanned into a NEIGHBOR project's
        // serve (pre-mortem #4) and warn instead of promoting the wrong DB.
        'x-pyric-project-dir': state.projectDir,
      });
      res.end(JSON.stringify(value));
      return;
    }
    if (req.method === 'DELETE') {
      if (writerId) lock.release(writerId);
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'PUT') {
      // Lock heartbeat -- refresh/claim WITHOUT writing state. 423 if another
      // live tab holds it.
      const claimed = lock.claim(writerId || 'anon', Date.now());
      res.writeHead(claimed ? 204 : 423).end();
      return;
    }
    if (req.method === 'POST') {
      if (section !== 'firestore' && section !== 'auth') {
        res.writeHead(400).end('section must be firestore|auth');
        return;
      }
      // Single-writer: the first page to flush claims the lock; a different
      // live page is refused (423) so it can't erase the writer's world.
      if (!lock.claim(writerId || 'anon', Date.now())) {
        res.writeHead(423, { 'content-type': 'text/plain' }).end(
          `another tab holds the persist writer lock (held by ${lock.holder()})`,
        );
        return;
      }
      const body = await collectBody(req);
      await state.writeSection(section, body);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(405, { allow: 'GET, POST, DELETE' }).end('method not allowed');
  } catch (e) {
    // StateFileError (corrupt/version) or bad body -- surface, don't clobber.
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
 * `pyric verify` can pick it up without any extra arguments.
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
    res.writeHead(405, { allow: 'GET, POST' }).end('method not allowed');
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
