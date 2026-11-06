/**
 * What capture S (issue #2114, Storage plan PR 1) needs beyond the RTDB live
 * captures: a recording `globalThis.fetch` for the Node builds of
 * `firebase/auth` and `firebase/storage`, a read-only check that the oracle
 * namespace rules are deployed, and the cleanup that removes every object
 * under the run prefix and reads the prefix back empty.
 *
 * The context (oracle credential, web config, run id) and redaction come from
 * `../rtdb-live/live-capture.ts`, so both captures share one credential path
 * and one list of credential patterns.
 */
import { createHash } from 'node:crypto';
import { oracleAccessToken } from '../../oracle-credential.ts';
import { pause, Redactor, type LiveContext } from '../rtdb-live/live-capture.ts';

/** Allowed for any signed-in user by the oracle rules (`storageOracleTarget`). */
export const RUN_ROOT = 'pyric_oracle';
/** Matched by no rule, so production denies every request under it. */
export const DENIED_ROOT = 'pyric_oracle_denied_storage';
export const STORAGE_HOST = 'firebasestorage.googleapis.com';
const AUTH_HOSTS = new Set(['identitytoolkit.googleapis.com', 'securetoken.googleapis.com']);

/** The variables a CI runner sets. Capture S reaches production, so it never runs there. */
const CI_VARIABLES = ['CI', 'GITHUB_ACTIONS'] as const;

export function captureRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const set = CI_VARIABLES.filter((name) => (env[name] ?? '') !== '');
  if (set.length === 0) return null;
  return `capture S reaches a production project, so it does not run in CI (${set.join(' and ')} set). Run it by hand.`;
}

// ─── Rules check (read only) ──────────────────────────────────────────────

const RULES_API = 'https://firebaserules.googleapis.com/v1';
const NAMESPACE_MATCH = /match\s+\/pyric_oracle\/\{run\}\/\{allPaths=\*\*\}\s*\{\s*allow read, write: if request\.auth != null;\s*\}/;

/** Why the bucket's rules do not give capture S what it needs, or null when they do. */
export function namespaceRulesRefusal(source: string): string | null {
  if (!NAMESPACE_MATCH.test(source)) return 'the bucket rules do not allow pyric_oracle/{run}/** to signed-in users';
  if (source.includes(DENIED_ROOT)) return `the bucket rules name ${DENIED_ROOT}, which capture S expects no rule to match`;
  return null;
}

/** Reads the bucket's released rules source; deploys nothing. */
export async function readBucketRules(ctx: LiveContext, bucket: string): Promise<string> {
  const token = await oracleAccessToken(ctx.serviceAccount, 'https://www.googleapis.com/auth/firebase');
  const headers = { Authorization: `Bearer ${token}` };
  const release = await fetch(`${RULES_API}/projects/${encodeURIComponent(ctx.projectId)}/releases/firebase.storage/${bucket}`, { headers });
  if (!release.ok) throw new Error(`cannot read the bucket rules release: ${release.status}`);
  const { rulesetName } = (await release.json()) as { rulesetName: string };
  const ruleset = await fetch(`${RULES_API}/${rulesetName}`, { headers });
  if (!ruleset.ok) throw new Error(`cannot read the bucket ruleset: ${ruleset.status}`);
  const files = ((await ruleset.json()) as { source?: { files?: Array<{ content: string }> } }).source?.files ?? [];
  return files.map((file) => file.content).join('\n');
}

// ─── Recording fetch ──────────────────────────────────────────────────────

export type BodySummary =
  | { kind: 'json'; json: unknown }
  | { kind: 'text'; text: string }
  | { kind: 'bytes'; length: number; sha256: string; base64?: string }
  | { kind: 'multipart'; parts: Array<{ contentType: string; body: BodySummary }> };

export interface Exchange {
  seq: number;
  t: number;
  op: string;
  client: string;
  service: 'storage' | 'auth';
  /** The account placeholder the `Authorization` header named, or null when it sent none. */
  account: string | null;
  method: string;
  host: string;
  path: string;
  query: Record<string, string>;
  request: { headers: Record<string, string>; body: BodySummary | null };
  response: { status: number; headers: Record<string, string>; body: BodySummary | null };
}

/** Bytes kept as base64 up to this length; a longer body keeps only its length and digest. */
const INLINE_BYTES = 4096;
const REQUEST_HEADERS = /^(?:content-type|x-goog-upload-.+)$/;
const RESPONSE_HEADERS = /^(?:content-type|x-goog-upload-.+)$/;
/** Query values that are per-run secrets or ids, replaced wherever they appear. */
const QUERY_PLACEHOLDERS: Record<string, string> = { upload_id: '<upload-session>', pageToken: '<page-token>', token: '<download-token>' };
/** Metadata fields that differ on every run. */
const FIELD_PLACEHOLDERS: Record<string, string> = {
  downloadTokens: '<download-token>',
  generation: '<generation>',
  timeCreated: '<time-created>',
  updated: '<time-updated>',
  etag: '<etag>',
  nextPageToken: '<page-token>',
};

function digest(bytes: Uint8Array): { length: number; sha256: string; base64?: string } {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const inline = bytes.length <= INLINE_BYTES ? { base64: Buffer.from(bytes).toString('base64') } : {};
  return { length: bytes.length, sha256, ...inline };
}

/**
 * Collects the Storage and Auth exchanges the SDKs make, each stamped with
 * milliseconds since the recorder started and the operation running then.
 * Authorization values are never kept: the header becomes the account it
 * names. Download tokens, upload session ids and page tokens are added to the
 * redactor as they are seen, so they are replaced everywhere in the file.
 */
export class FetchRecorder {
  readonly start = performance.now();
  readonly exchanges: Exchange[] = [];
  op = 'signIn';
  client = 'client-1';
  private readonly accounts = new Map<string, string>();
  private readonly pending: Array<Promise<void>> = [];

  constructor(private readonly redactor: Redactor) {}

  /** The account placeholder for an ID token the app holds. */
  account(idToken: string, placeholder: string): void {
    this.accounts.set(idToken, placeholder);
  }

  now(): number {
    return Math.round((performance.now() - this.start) * 10) / 10;
  }

  /** Waits for every response body still being read. */
  async settled(): Promise<void> {
    while (this.pending.length > 0) await Promise.all(this.pending.splice(0));
  }

  /** Wraps `real`; only Storage and Auth hosts are recorded, and every request is forwarded unchanged. */
  wrap(real: typeof fetch): typeof fetch {
    const recorder = this;
    const recording = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const service = url.hostname === STORAGE_HOST ? 'storage' : AUTH_HOSTS.has(url.hostname) ? 'auth' : null;
      if (service === null) return real(input, init);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const exchange = recorder.begin(service, url, init?.method ?? 'GET', headers);
      const requestBody = await recorder.summarizeRequest(init?.body ?? null, headers.get('content-type'));
      const response = await real(input, init);
      exchange.request.body = requestBody;
      exchange.response.status = response.status;
      exchange.response.headers = recorder.keptHeaders(response.headers, RESPONSE_HEADERS);
      const copy = response.clone();
      recorder.pending.push(recorder.summarizeResponse(copy).then((body) => { exchange.response.body = body; }));
      return response;
    };
    return recording as typeof fetch;
  }

  private begin(service: Exchange['service'], url: URL, method: string, headers: Headers): Exchange {
    const authorization = headers.get('authorization');
    const token = authorization?.replace(/^Firebase\s+/, '') ?? null;
    const exchange: Exchange = {
      seq: this.exchanges.length + 1,
      t: this.now(),
      op: this.op,
      client: this.client,
      service,
      account: token === null ? null : (this.accounts.get(token) ?? '<unknown-account>'),
      method,
      host: url.hostname,
      path: url.pathname,
      query: this.query(url.searchParams),
      request: { headers: this.keptHeaders(headers, REQUEST_HEADERS), body: null },
      response: { status: 0, headers: {}, body: null },
    };
    this.exchanges.push(exchange);
    return exchange;
  }

  private query(params: URLSearchParams): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of params) {
      const placeholder = QUERY_PLACEHOLDERS[key];
      if (placeholder) this.redactor.add(value, placeholder);
      out[key] = placeholder ?? value;
    }
    return out;
  }

  private keptHeaders(headers: Headers, kept: RegExp): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, name) => {
      if (!kept.test(name)) return;
      out[name] = /url$/.test(name) ? this.noteUrlSecrets(value) : value.replace(/boundary=\d+/, 'boundary=<boundary>');
    });
    return out;
  }

  /** Adds the URL's session id to the redactor; the value is replaced when the file is written. */
  private noteUrlSecrets(value: string): string {
    const url = new URL(value);
    for (const [key, placeholder] of Object.entries(QUERY_PLACEHOLDERS)) {
      const secret = url.searchParams.get(key);
      if (secret) this.redactor.add(secret, placeholder);
    }
    return value;
  }

  private fields(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.fields(item));
    if (value === null || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      const placeholder = FIELD_PLACEHOLDERS[key];
      if (placeholder && typeof field === 'string') {
        for (const token of key === 'downloadTokens' ? field.split(',') : [field]) this.redactor.add(token, placeholder);
        out[key] = placeholder;
      } else {
        out[key] = this.fields(field);
      }
    }
    return out;
  }

  private textBody(bytes: Uint8Array, contentType: string | null): BodySummary {
    const text = Buffer.from(bytes).toString('utf8');
    if (/json/.test(contentType ?? '')) {
      try {
        return { kind: 'json', json: this.fields(JSON.parse(text)) };
      } catch {
        return { kind: 'text', text };
      }
    }
    return { kind: 'text', text };
  }

  private bodyOf(bytes: Uint8Array, contentType: string | null): BodySummary {
    if (/json|^text\//.test(contentType ?? '')) return this.textBody(bytes, contentType);
    return { kind: 'bytes', ...digest(bytes) };
  }

  private multipart(bytes: Uint8Array, boundary: string): BodySummary {
    const buffer = Buffer.from(bytes);
    const delimiter = Buffer.from(`--${boundary}`);
    const parts: Array<{ contentType: string; body: BodySummary }> = [];
    let at = buffer.indexOf(delimiter);
    while (at !== -1) {
      const from = at + delimiter.length;
      if (buffer.subarray(from, from + 2).toString() === '--') break;
      const next = buffer.indexOf(delimiter, from);
      const part = buffer.subarray(from + 2, next === -1 ? buffer.length : next - 2);
      const split = part.indexOf('\r\n\r\n');
      const head = part.subarray(0, split).toString();
      const contentType = /content-type:\s*(.+)/i.exec(head)?.[1]?.trim() ?? '';
      parts.push({ contentType, body: this.bodyOf(part.subarray(split + 4), contentType) });
      at = next;
    }
    return { kind: 'multipart', parts };
  }

  private async summarizeRequest(body: BodyInit | null, contentType: string | null): Promise<BodySummary | null> {
    if (body === null || body === undefined) return null;
    if (body instanceof ReadableStream) throw new Error('capture S cannot record a streamed request body');
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    const boundary = /multipart\/related;\s*boundary=(\S+)/.exec(contentType ?? '')?.[1];
    if (boundary) return this.multipart(bytes, boundary);
    return this.bodyOf(bytes, contentType);
  }

  private async summarizeResponse(response: Response): Promise<BodySummary | null> {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) return null;
    return this.bodyOf(bytes, response.headers.get('content-type'));
  }
}

/**
 * Install the recorder as `globalThis.fetch`. Call before the first import of
 * `firebase/auth`, whose Node build takes `fetch` when it loads; the Storage
 * build reads the global on each request. Returns the uninstall.
 */
export function installFetchRecorder(recorder: FetchRecorder): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = recorder.wrap(real);
  return () => { globalThis.fetch = real; };
}

export function storageRedactor(ctx: LiveContext, bucket: string): Redactor {
  const redactor = new Redactor();
  redactor.add(bucket, '<bucket>');
  redactor.add(ctx.webConfig.apiKey, '<api-key>');
  redactor.add(ctx.webConfig.appId, '<app-id>');
  redactor.add(ctx.runId, '<run>');
  redactor.add(ctx.projectId, '<project>');
  return redactor;
}

// ─── Run cleanup ──────────────────────────────────────────────────────────

/** The objects under a prefix, as the capture's signed-in client sees them. */
export interface RunObjects {
  /** Every object path under `prefix`, at any depth. */
  list(prefix: string): Promise<string[]>;
  remove(path: string): Promise<void>;
}

export interface StorageInvariants {
  /** The run prefix was listed after cleanup and held no object. */
  runPrefixEmpty: boolean;
  /** Every account the capture signed in was deleted. */
  accountsDeleted: boolean;
}

export interface StorageCleanupOptions {
  /** Stops anything still writing (an upload task) before the prefix is listed. */
  quiesce?: () => Promise<void>;
  /** Wait after `quiesce` for a request already sent to land. */
  settleMs?: number;
  /** Deletes the accounts and apps, after the objects are removed. Throws when an account was not deleted. */
  shutdown?: () => Promise<void>;
  /** Install SIGINT and SIGTERM handlers that run the same cleanup once, then exit. */
  handleSignals?: boolean;
}

export interface StorageRunResult<T> {
  result?: T;
  error?: Error;
  invariants: StorageInvariants;
  failures: string[];
}

async function attempt<T>(failures: string[], step: string, task: () => Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch (e) {
    failures.push(`${step}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * The cleanup after a run. Every step runs whatever the earlier ones did: a
 * failed delete still lists the prefix and deletes the accounts. A failed step
 * is an invariant failure, never a throw.
 */
export async function cleanupStorageRun(
  label: string,
  objects: RunObjects,
  prefix: string,
  options: Omit<StorageCleanupOptions, 'handleSignals'> = {},
): Promise<{ invariants: StorageInvariants; failures: string[] }> {
  const failures: string[] = [];
  if (options.quiesce) await attempt(failures, 'quiesce', options.quiesce);
  if (options.settleMs) await pause(options.settleMs);
  const left = (await attempt(failures, 'list run prefix', () => objects.list(prefix))) ?? [];
  for (const path of left) await attempt(failures, `remove ${path}`, () => objects.remove(path));
  const back = await attempt(failures, 'read run prefix back', () => objects.list(prefix));
  const shutdown = options.shutdown ? await attempt(failures, 'shutdown', async () => { await options.shutdown!(); return true; }) : true;
  const invariants = { runPrefixEmpty: back !== null && back.length === 0, accountsDeleted: shutdown === true };
  if (!invariants.runPrefixEmpty || !invariants.accountsDeleted || failures.length > 0) {
    console.error(`[storage-live] ${label}: invariant failed`, invariants, { failures, leftAfterCleanup: back?.length ?? null });
    console.error(`[storage-live] ${label}: list the run prefix and the capture's accounts by hand.`);
  }
  return { invariants, failures };
}

/**
 * Refuse a run prefix that already holds objects, run `body`, then remove
 * every object under the prefix and read it back. The invariants are reported
 * whether or not `body` threw.
 */
export async function runWithStorageCleanup<T>(
  label: string,
  objects: RunObjects,
  prefix: string,
  body: () => Promise<T>,
  options: StorageCleanupOptions = {},
): Promise<StorageRunResult<T>> {
  const existing = await objects.list(prefix);
  if (existing.length > 0) throw new Error(`${label}: refusing: the run prefix already holds ${existing.length} objects`);

  let cleanup: Promise<{ invariants: StorageInvariants; failures: string[] }> | undefined;
  const cleanupOnce = () => (cleanup ??= cleanupStorageRun(label, objects, prefix, options));
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`[storage-live] ${label}: ${signal}; cleaning up before exit.`);
    void cleanupOnce().then(({ invariants }) => process.exit(invariants.runPrefixEmpty && invariants.accountsDeleted ? 130 : 3));
  };
  if (options.handleSignals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  let result: T | undefined;
  let error: Error | undefined;
  try {
    result = await body();
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  const { invariants, failures } = await cleanupOnce();
  if (options.handleSignals) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return { result, error, invariants, failures };
}
