/**
 * Capture S, the production recording the live-mode Storage replay serves
 * (issue #2114, Storage plan PR 1): every listed operation has exchanges, the
 * denials are production's 403 with its body, the resumable start, query and
 * finalize headers are present, and no credential, project id or bucket name
 * survived redaction.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECORDING = join(dirname(fileURLToPath(import.meta.url)), '../../../../src/capture/storage-live/recordings/capture-s-wire.json');

/** Written out here rather than imported, so a gap in the capture's own list cannot hide a leak. */
const CREDENTIAL_PATTERNS: Array<[string, RegExp]> = [
  ['JWT (ID token, custom token)', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['Google OAuth access token', /ya29\.[A-Za-z0-9_-]{10,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{30,}/],
  ['Firebase refresh token', /AMf-v[A-Za-z0-9_-]{20,}/],
  ['Google refresh token', /1\/\/0[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['bearer header', /Bearer\s+[A-Za-z0-9._-]{20,}/i],
  ['Firebase authorization header', /Firebase\s+[A-Za-z0-9._-]{20,}/],
  ['access_token query', /access_token=[^&"<]{10,}/],
];

/** The operations capture S runs, in order; each must have at least one exchange. */
const OPERATIONS = [
  'signIn', 'preflight', 'uploadBytes', 'uploadString-raw', 'uploadString-base64', 'uploadBytesResumable',
  'uploadBytesResumable-paused', 'getMetadata', 'getDownloadURL', 'getBytes', 'getStream',
  'updateMetadata', 'setup-nested', 'list', 'listAll', 'getMetadata-second-account', 'deleteObject',
  'getMetadata-missing', 'deleteObject-missing', 'denied-upload', 'denied-getBytes', 'denied-list',
  'signed-out-upload', 'cleanup', 'teardown',
];
const DENIED = ['denied-upload', 'denied-getBytes', 'denied-list', 'signed-out-upload'];
const MISSING = ['getMetadata-missing', 'deleteObject-missing'];

type Body =
  | { kind: 'json'; json: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; length: number; sha256: string; base64?: string }
  | { kind: 'multipart'; parts: Array<{ contentType: string; body: Body }> };

interface Exchange {
  seq: number;
  t: number;
  op: string;
  client: string;
  service: 'storage' | 'auth';
  account: string | null;
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  request: { headers: Record<string, string>; body: Body | null };
  response: { status: number; headers: Record<string, string>; body: Body | null };
}

interface Recording {
  name: string;
  sdkVersion: string;
  bucket: string;
  runPath: string;
  deniedPath: string;
  operations: string[];
  accounts: string[];
  results: Record<string, { ok: boolean; code?: string }>;
  invariants: { runPrefixEmpty: boolean; accountsDeleted: boolean };
  exchanges: Exchange[];
}

const text = readFileSync(RECORDING, 'utf8');
const recording = JSON.parse(text) as Recording;
const storage = recording.exchanges.filter((e) => e.service === 'storage');
const of = (op: string) => recording.exchanges.filter((e) => e.op === op);
const command = (e: Exchange) => e.request.headers['x-goog-upload-command'] ?? '';

/**
 * The project id and bucket the capture ran against, from the env the script
 * reads. Committed code names neither, so this check runs only where it is set.
 */
function capturedNames(): string[] {
  const project = process.env.PYRIC_ORACLE_PROJECT_ID ?? '';
  return project === '' ? [] : [project];
}
const CAPTURED_NAMES = capturedNames();

describe('capture S: Storage wire recording', () => {
  test('names the SDK, the bucket, the run paths and every operation', () => {
    expect(recording.name).toBe('storage-live-capture-s-wire');
    expect(recording.sdkVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(recording.bucket).toBe('<bucket>');
    expect(recording.runPath).toBe('pyric_oracle/<run>');
    expect(recording.deniedPath).toBe('pyric_oracle_denied_storage/<run>');
    expect(recording.operations).toEqual(OPERATIONS);
    expect(recording.accounts).toEqual(['<uid-1>', '<uid-2>']);
    expect(recording.invariants).toEqual({ runPrefixEmpty: true, accountsDeleted: true });
  });

  test('every listed operation has exchanges, in order, and each names a listed operation', () => {
    for (const op of OPERATIONS) expect({ op, exchanges: of(op).length > 0 }).toEqual({ op, exchanges: true });
    let previous = 0;
    for (const exchange of recording.exchanges) {
      expect(OPERATIONS).toContain(exchange.op);
      expect(exchange.t).toBeGreaterThanOrEqual(previous);
      previous = exchange.t;
      expect(exchange.response.status).toBeGreaterThan(0);
    }
  });

  test('every Storage exchange is on the default bucket, and every signed-in one names its account', () => {
    expect(storage.length).toBeGreaterThan(0);
    for (const exchange of storage) {
      expect(exchange.host).toBe('firebasestorage.googleapis.com');
      expect(exchange.path.startsWith('/v0/b/<bucket>/o')).toBe(true);
      if (exchange.op !== 'signed-out-upload') expect(exchange.account).toMatch(/^<uid-[12]>$/);
    }
    for (const exchange of of('signed-out-upload')) expect(exchange.account).toBeNull();
  });

  test('every allowed operation succeeded', () => {
    for (const op of OPERATIONS.filter((o) => !DENIED.includes(o) && !MISSING.includes(o))) {
      expect({ op, ok: recording.results[op]?.ok }).toEqual({ op, ok: true });
    }
  });

  test.each(DENIED)('%s is production\'s 403 with its body and storage/unauthorized', (op) => {
    expect(recording.results[op]).toEqual({ ok: false, code: 'storage/unauthorized' });
    const exchanges = of(op).filter((e) => e.service === 'storage');
    expect(exchanges.length).toBeGreaterThan(0);
    for (const exchange of exchanges) {
      expect(exchange.response.status).toBe(403);
      const body = exchange.response.body as { kind: string; json: { error: { code: number; message: string } } };
      expect(body.kind).toBe('json');
      expect(body.json.error.code).toBe(403);
      expect(typeof body.json.error.message).toBe('string');
    }
  });

  test.each(MISSING)('%s is a 404 and storage/object-not-found', (op) => {
    expect(recording.results[op]).toEqual({ ok: false, code: 'storage/object-not-found' });
    for (const exchange of of(op)) expect(exchange.response.status).toBe(404);
  });

  test.each(['uploadBytesResumable', 'uploadBytesResumable-paused'])('%s has the resumable start and finalize headers', (op) => {
    const exchanges = of(op);
    const start = exchanges.find((e) => command(e) === 'start')!;
    expect(start.request.headers['x-goog-upload-protocol']).toBe('resumable');
    expect(start.request.headers['x-goog-upload-header-content-length']).toMatch(/^\d+$/);
    expect(start.response.status).toBe(200);
    expect(start.response.headers['x-goog-upload-status']).toBe('active');
    expect(start.response.headers['x-goog-upload-url']).toContain('<upload-session>');
    const chunks = exchanges.filter((e) => command(e).includes('upload'));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.request.headers['x-goog-upload-offset']).toMatch(/^\d+$/);
      expect(chunk.query.upload_id).toBe('<upload-session>');
      expect(chunk.request.body?.kind).toBe('bytes');
    }
    const finalize = chunks.find((e) => command(e) === 'upload, finalize')!;
    expect(finalize.response.status).toBe(200);
    expect(finalize.response.headers['x-goog-upload-status']).toBe('final');
    expect(chunks.filter((e) => e !== finalize).every((e) => e.response.headers['x-goog-upload-status'] === 'active')).toBe(true);
  });

  test('the paused upload queried its session before resuming', () => {
    const query = of('uploadBytesResumable-paused').find((e) => command(e) === 'query')!;
    expect(query.response.status).toBe(200);
    expect(query.response.headers['x-goog-upload-status']).toBe('active');
    expect(query.response.headers['x-goog-upload-size-received']).toMatch(/^\d+$/);
  });

  test('a multipart upload sends its metadata and bytes, and production answers with metadata', () => {
    const upload = of('uploadBytes').find((e) => e.method === 'POST')!;
    expect(upload.request.headers['x-goog-upload-protocol']).toBe('multipart');
    expect(upload.request.headers['content-type']).toBe('multipart/related; boundary=<boundary>');
    const body = upload.request.body as { kind: string; parts: Array<{ body: Body }> };
    expect(body.kind).toBe('multipart');
    expect(body.parts.map((p) => p.body.kind)).toEqual(['json', 'bytes']);
    expect((body.parts[1]!.body as { length: number }).length).toBe(6);
    const metadata = (upload.response.body as { json: Record<string, unknown> }).json;
    expect(metadata.bucket).toBe('<bucket>');
    expect(metadata.name).toBe('pyric_oracle/<run>/a.bin');
    expect(metadata.size).toBe('6');
    expect(metadata.generation).toBe('<generation>');
    expect(metadata.timeCreated).toBe('<time-created>');
    expect(metadata.downloadTokens).toBe('<download-token>');
  });

  test('list pages through with production\'s page token', () => {
    const [first, second] = of('list');
    expect(first!.query.maxResults).toBe('2');
    const page = (first!.response.body as { json: { items: unknown[]; nextPageToken?: string } }).json;
    expect(page.items.length).toBe(2);
    expect(page.nextPageToken).toBe('<page-token>');
    expect(second!.query.pageToken).toBe('<page-token>');
  });

  test('a download sends the object\'s bytes', () => {
    const media = of('getBytes').find((e) => e.query.alt === 'media')!;
    expect(media.response.status).toBe(200);
    expect(media.response.body).toMatchObject({ kind: 'bytes', length: 6 });
  });

  test('no request header carries a credential, and no credential pattern is left', () => {
    for (const exchange of recording.exchanges) {
      expect(Object.keys(exchange.request.headers)).not.toContain('authorization');
      expect(Object.keys(exchange.request.headers)).not.toContain('x-firebase-appcheck');
    }
    for (const [label, pattern] of CREDENTIAL_PATTERNS) {
      expect({ label, match: pattern.exec(text)?.[0] ?? null }).toEqual({ label, match: null });
    }
    expect(text).not.toMatch(/"localId":\s*"(?!<uid-\d+>)/);
    expect(text).not.toMatch(/upload_id=(?!<upload-session>)/);
    expect(text).not.toMatch(/"downloadTokens":\s*"(?!<download-token>)/);
  });

  test.skipIf(CAPTURED_NAMES.length === 0)('names neither the project nor the bucket it ran against', () => {
    for (const name of CAPTURED_NAMES) expect({ name, present: text.includes(name) }).toEqual({ name, present: false });
  });
});
