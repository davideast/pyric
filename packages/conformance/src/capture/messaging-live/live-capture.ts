/**
 * What capture M (issue #2114, Messaging M-1) shares with its tests: the env
 * it needs, the credential, the two restricted API keys it creates and
 * deletes, the cleanup that restores production and reads it back, and the
 * redaction the recording passes before it is written.
 *
 * Env, matching the messaging-web harness (`../messaging-web/harness.ts`):
 *   PYRIC_MESSAGING_FIREBASE_CONFIG  web app config JSON of the harness project
 *   PYRIC_MESSAGING_VAPID_KEY        that project's Web Push certificate public key
 *   PYRIC_MESSAGING_PROJECT_ID       the project, for Application Default Credentials
 *                                    (or PYRIC_ORACLE_PROJECT_ID when it is the oracle project)
 *
 * The credential is the oracle credential through Application Default
 * Credentials (`src/oracle-credential.ts`, by way of `src/messaging-credential.ts`).
 * A base64 key in PYRIC_MESSAGING_SA_BASE64 is ignored. Nothing here names a
 * project, and nothing the credential loader would log is printed.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { applicationDefault, cert } from 'firebase-admin/app';
import {
  loadMessagingServiceAccount,
  MESSAGING_KEY_VARIABLE,
  MESSAGING_PROJECT_VARIABLE,
  type MessagingCredentialDeps,
} from '../../messaging-credential.ts';
import { oracleAccessToken, type OracleServiceAccount } from '../../oracle-credential.ts';
import { CREDENTIAL_PATTERNS, Redactor } from '../rtdb-live/live-capture.ts';

export { Redactor } from '../rtdb-live/live-capture.ts';

export const CONFIG_VARIABLE = 'PYRIC_MESSAGING_FIREBASE_CONFIG';
export const VAPID_VARIABLE = 'PYRIC_MESSAGING_VAPID_KEY';
const ORACLE_PROJECT_VARIABLE = 'PYRIC_ORACLE_PROJECT_ID';

export type CaptureEnv = Readonly<Record<string, string | undefined>>;

/** Inert unless the harness's web config and VAPID key are both set. */
export function captureIsInert(env: CaptureEnv): boolean {
  return !env[CONFIG_VARIABLE] && !env[VAPID_VARIABLE];
}

/** The names of the variables the capture needs and does not have. Never their values. */
export function missingVariables(env: CaptureEnv): string[] {
  const missing = [CONFIG_VARIABLE, VAPID_VARIABLE].filter((name) => !env[name]);
  if (!env[MESSAGING_PROJECT_VARIABLE] && !env[ORACLE_PROJECT_VARIABLE]) {
    missing.push(`${MESSAGING_PROJECT_VARIABLE} (or ${ORACLE_PROJECT_VARIABLE})`);
  }
  return missing;
}

const quietDeps: MessagingCredentialDeps = {
  cert: (key) => cert(key as Parameters<typeof cert>[0]),
  applicationDefault: () => applicationDefault(),
  log: () => {},
  warn: () => {},
};

/** The oracle credential through Application Default Credentials, on the harness's project. */
export function loadCaptureCredential(env: CaptureEnv): Promise<OracleServiceAccount> {
  return loadMessagingServiceAccount({ ...env, [MESSAGING_KEY_VARIABLE]: undefined }, quietDeps);
}

export function newRunId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Where every run id is appended, so a run that stops partway can still be cleaned up. */
export function runIdFile(): string {
  return join(tmpdir(), 'pyric-capture-m-run-ids.log');
}

export interface RunIdNotice {
  write?: (line: string) => void;
  file?: string;
}

/**
 * Print the real run id and its cleanup command, and append both to the run-id
 * file. The run id is not a credential: it goes out through a path the redactor
 * never touches, so `--cleanup <run id>` is usable. The recording still reads `<run>`.
 */
export function announceRunId(runId: string, notice: RunIdNotice = {}): string {
  const line = `[capture-m] run ${runId}; if it stops partway, run the cleanup with --cleanup ${runId}`;
  (notice.write ?? console.log)(line);
  appendFileSync(notice.file ?? runIdFile(), `${new Date().toISOString()} ${line}\n`);
  return line;
}

// ─── Restricted API keys ──────────────────────────────────────────────────

/**
 * The three restricted keys, created together so they share one propagation wait:
 * referrer-blocked (localhost is not an allowed referrer), installations-only
 * (API targets: Installations alone; production still lets registrations through),
 * and other-api-only (API targets: one API that is neither, so Installations refuses it).
 */
export type KeyRestriction = 'referrer-blocked' | 'installations-only' | 'other-api-only';
export const KEY_RESTRICTIONS: readonly KeyRestriction[] = ['referrer-blocked', 'installations-only', 'other-api-only'];

/** A referrer no page of the capture is served from, so localhost is blocked. */
export const ALLOWED_REFERRER = 'https://pyric-capture-m.invalid/*';
export const INSTALLATIONS_SERVICE = 'firebaseinstallations.googleapis.com';
/** A harmless API that is neither Installations nor FCM registrations. */
export const OTHER_API_SERVICE = 'firebaseremoteconfig.googleapis.com';

const KEY_ID_SUFFIX: Record<KeyRestriction, string> = {
  'referrer-blocked': 'ref',
  'installations-only': 'fis',
  'other-api-only': 'rc',
};

const KEY_RESTRICTION_BODY: Record<KeyRestriction, Record<string, unknown>> = {
  'referrer-blocked': { browserKeyRestrictions: { allowedReferrers: [ALLOWED_REFERRER] } },
  'installations-only': { apiTargets: [{ service: INSTALLATIONS_SERVICE }] },
  'other-api-only': { apiTargets: [{ service: OTHER_API_SERVICE }] },
};

export interface ApiKeyEntry {
  name: string;
  displayName: string;
}

export interface CreatedKey extends ApiKeyEntry {
  restriction: KeyRestriction;
  keyString: string;
}

/** The API Keys API calls the capture makes. Tests supply a fake. */
export interface ApiKeys {
  /** Live (not deleted) keys whose display name carries the run id. */
  list(runId: string): Promise<ApiKeyEntry[]>;
  create(runId: string, restriction: KeyRestriction): Promise<CreatedKey>;
  remove(name: string): Promise<void>;
  /** True when the key reads back as deleted or is gone. */
  isDeleted(name: string): Promise<boolean>;
}

export function keyDisplayName(runId: string, restriction: KeyRestriction): string {
  return `pyric capture m ${runId} ${restriction}`;
}

export function keyId(runId: string, restriction: KeyRestriction): string {
  return `pyric-m-${runId}-${KEY_ID_SUFFIX[restriction]}`.toLowerCase();
}

export function keyRestrictions(restriction: KeyRestriction): Record<string, unknown> {
  return KEY_RESTRICTION_BODY[restriction];
}

const API_KEYS = 'https://apikeys.googleapis.com/v2';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

interface Operation {
  name: string;
  done?: boolean;
  error?: { code?: number; message?: string };
  response?: { name?: string; displayName?: string; keyString?: string };
}

/** The API Keys API on `projectId`, with the oracle credential. */
export function apiKeysRest(sa: OracleServiceAccount, projectId: string, fetchImpl: typeof fetch = fetch): ApiKeys {
  const keysUrl = `${API_KEYS}/projects/${encodeURIComponent(projectId)}/locations/global/keys`;
  async function call(method: string, url: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const token = await oracleAccessToken(sa, CLOUD_PLATFORM_SCOPE);
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
  }
  async function settle(start: { status: number; json: Record<string, unknown> }, label: string): Promise<Operation> {
    if (start.status !== 200) throw new Error(`${label} answered ${start.status}: ${errorMessage(start.json)}`);
    let operation = start.json as unknown as Operation;
    for (let attempt = 0; !operation.done && attempt < 60; attempt++) {
      await pause(1_000);
      const next = await call('GET', `${API_KEYS}/${operation.name}`);
      if (next.status !== 200) throw new Error(`${label} operation answered ${next.status}: ${errorMessage(next.json)}`);
      operation = next.json as unknown as Operation;
    }
    if (!operation.done) throw new Error(`${label} did not finish in 60 s`);
    if (operation.error) throw new Error(`${label} failed: ${operation.error.message ?? operation.error.code}`);
    return operation;
  }
  return {
    async list(runId) {
      const found: ApiKeyEntry[] = [];
      let pageToken = '';
      do {
        const page = await call('GET', `${keysUrl}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
        if (page.status !== 200) throw new Error(`key list answered ${page.status}: ${errorMessage(page.json)}`);
        const keys = (page.json.keys as ApiKeyEntry[] | undefined) ?? [];
        for (const key of keys) if ((key.displayName ?? '').includes(runId)) found.push({ name: key.name, displayName: key.displayName });
        pageToken = (page.json.nextPageToken as string | undefined) ?? '';
      } while (pageToken !== '');
      return found;
    },
    async create(runId, restriction) {
      const body = { displayName: keyDisplayName(runId, restriction), restrictions: keyRestrictions(restriction) };
      const done = await settle(await call('POST', `${keysUrl}?keyId=${keyId(runId, restriction)}`, body), `create ${restriction} key`);
      const name = done.response?.name;
      if (!name) throw new Error(`create ${restriction} key returned no key name`);
      const keyString = await call('GET', `${API_KEYS}/${name}/keyString`);
      const value = keyString.json.keyString;
      if (keyString.status !== 200 || typeof value !== 'string') throw new Error(`read ${restriction} key string answered ${keyString.status}`);
      return { name, displayName: body.displayName, restriction, keyString: value };
    },
    async remove(name) {
      await settle(await call('DELETE', `${API_KEYS}/${name}`), 'delete key');
    },
    async isDeleted(name) {
      const key = await call('GET', `${API_KEYS}/${name}`);
      if (key.status === 404) return true;
      return key.status === 200 && typeof key.json.deleteTime === 'string';
    },
  };
}

function errorMessage(json: Record<string, unknown>): string {
  const error = json.error as { status?: string; message?: string } | undefined;
  return error ? `${error.status ?? ''} ${error.message ?? ''}`.trim() : 'no error body';
}

// ─── Cleanup ──────────────────────────────────────────────────────────────

/** What the client side reads back once it deleted every token, installation and push subscription it made. */
export interface ClientReadBack {
  tokensDeleted: boolean;
  installationsDeleted: boolean;
}

export interface RunInvariants extends ClientReadBack {
  keysDeleted: boolean;
}

export interface KeyCounts {
  /** Live keys carrying the run id before the run created any. */
  before: number;
  created: number;
  /** Live keys carrying the run id after cleanup. */
  after: number;
}

export interface CaptureCleanupOptions {
  /** Deletes the run's tokens, installations and push subscription and reads each back. */
  client: () => Promise<ClientReadBack>;
  /** Install SIGINT and SIGTERM handlers that run the same cleanup once, then exit. */
  handleSignals?: boolean;
  log?: (message: string) => void;
}

export interface CaptureCleanupResult<T> {
  result?: T;
  error?: Error;
  invariants: RunInvariants;
  keys: KeyCounts;
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
 * The cleanup after a run. Every step runs whatever the earlier ones did: the
 * client state first (it needs the browser), then every key the run created or
 * that the list shows under its run id, then the list again, which must be
 * empty, and each key read back as deleted. A failed step is an invariant
 * failure, never a throw.
 */
export async function cleanupCaptureRun(
  keys: ApiKeys,
  runId: string,
  created: readonly ApiKeyEntry[],
  options: Pick<CaptureCleanupOptions, 'client' | 'log'>,
): Promise<{ invariants: RunInvariants; after: number; failures: string[] }> {
  const failures: string[] = [];
  const client = await attempt(failures, 'client cleanup', options.client);
  const listed = await attempt(failures, 'list run keys', () => keys.list(runId));
  const names = [...new Set([...created.map((k) => k.name), ...(listed ?? []).map((k) => k.name)])];
  const removed: string[] = [];
  for (const name of names) {
    const done = await attempt(failures, 'delete key', async () => {
      await keys.remove(name);
      return true;
    });
    if (done) removed.push(name);
  }
  const after = await attempt(failures, 'list run keys after', () => keys.list(runId));
  let readBack = true;
  for (const name of names) {
    const deleted = await attempt(failures, 'read key back', () => keys.isDeleted(name));
    readBack &&= deleted === true;
  }
  const invariants: RunInvariants = {
    tokensDeleted: client?.tokensDeleted === true,
    installationsDeleted: client?.installationsDeleted === true,
    keysDeleted: removed.length === names.length && after !== null && after.length === 0 && readBack,
  };
  if (!invariants.tokensDeleted || !invariants.installationsDeleted || !invariants.keysDeleted || failures.length > 0) {
    options.log?.(`[capture-m] cleanup invariant failed: ${JSON.stringify(invariants)}; ${failures.join('; ') || 'no step threw'}`);
    options.log?.(`[capture-m] run the cleanup again with --cleanup ${runId}, and read the keys back by hand.`);
  }
  return { invariants, after: after?.length ?? -1, failures };
}

/**
 * List the run's keys (none may exist yet), create the restricted keys,
 * run `body`, then clean up once and read everything back. The invariants are
 * reported whether or not `body` threw.
 */
export async function runWithCaptureCleanup<T>(
  keys: ApiKeys,
  runId: string,
  body: (created: Record<KeyRestriction, CreatedKey>) => Promise<T>,
  options: CaptureCleanupOptions,
): Promise<CaptureCleanupResult<T>> {
  const before = await keys.list(runId);
  if (before.length !== 0) throw new Error(`refusing: ${before.length} API keys already carry run id ${runId}`);
  const created: CreatedKey[] = [];

  let cleanup: ReturnType<typeof cleanupCaptureRun> | undefined;
  const cleanupOnce = () => (cleanup ??= cleanupCaptureRun(keys, runId, created, options));
  const onSignal = (signal: NodeJS.Signals) => {
    options.log?.(`[capture-m] ${signal}; cleaning up before exit.`);
    void cleanupOnce().then(({ invariants }) => process.exit(allHeld(invariants) ? 130 : 3));
  };
  if (options.handleSignals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  let result: T | undefined;
  let error: Error | undefined;
  try {
    for (const restriction of KEY_RESTRICTIONS) created.push(await keys.create(runId, restriction));
    const byRestriction = Object.fromEntries(created.map((k) => [k.restriction, k])) as Record<KeyRestriction, CreatedKey>;
    result = await body(byRestriction);
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  const { invariants, after } = await cleanupOnce();
  if (options.handleSignals) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return { result, error, invariants, keys: { before: before.length, created: created.length, after } };
}

export function allHeld(invariants: RunInvariants): boolean {
  return invariants.tokensDeleted && invariants.installationsDeleted && invariants.keysDeleted;
}

// ─── Exchanges ────────────────────────────────────────────────────────────

export const INSTALLATIONS_HOST = 'firebaseinstallations.googleapis.com';
export const REGISTRATIONS_HOST = 'fcmregistrations.googleapis.com';
export type ExchangeApi = 'installations' | 'registrations';

/** One request the page's `fetch` sent to either host, as the init script saw it, with the browser's response headers. */
export interface RawExchange {
  op: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responseBody: string | null;
  fetchError?: string;
  /** Every response header, from the browser's network layer (the page sees only the exposed ones). */
  responseHeaders: Record<string, string> | null;
}

export interface RecordedExchange {
  op: string;
  api: ExchangeApi;
  action: string;
  method: string;
  host: string;
  path: string;
  requestHeaderNames: string[];
  requestContentType: string | null;
  requestBodyKeys: string[];
  status: number | null;
  responseHeaderNames: string[];
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  fetchError?: string;
}

/** The response headers the SDK, CORS or Resource Timing read; every other value is dropped, its name kept. */
export const KEPT_RESPONSE_HEADERS = [
  'content-type',
  'timing-allow-origin',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-expose-headers',
  'vary',
];

export function exchangeApi(url: string): ExchangeApi | null {
  const host = new URL(url).hostname;
  if (host === INSTALLATIONS_HOST) return 'installations';
  if (host === REGISTRATIONS_HOST) return 'registrations';
  return null;
}

/** The action names the plan's row uses: Installations create, generateAuthToken or delete; registrations create, update or delete. */
export function exchangeAction(api: ExchangeApi, method: string, path: string): string {
  if (api === 'installations') {
    if (path.endsWith('/authTokens:generate')) return 'generateAuthToken';
    if (method === 'DELETE') return 'delete';
    return method === 'POST' ? 'create' : method.toLowerCase();
  }
  if (method === 'POST') return 'create';
  if (method === 'PATCH') return 'update';
  if (method === 'DELETE') return 'delete';
  return method.toLowerCase();
}

/** Every key path in a JSON value, sorted: `web.endpoint`, `installation.appId`. */
export function keyPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const paths: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    paths.push(path, ...keyPaths(child, path));
  }
  return paths.sort();
}

function parseJson(text: string | null): unknown {
  if (text === null || text === '') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Reduce one raw exchange to what the recording keeps. Secrets in it are left for the redactor. */
export function recordExchange(raw: RawExchange): RecordedExchange {
  const url = new URL(raw.url);
  const api = exchangeApi(raw.url);
  if (!api) throw new Error(`not a watched host: ${url.hostname}`);
  const headers = raw.responseHeaders ?? {};
  const kept: Record<string, string> = {};
  for (const name of KEPT_RESPONSE_HEADERS) if (headers[name] !== undefined) kept[name] = headers[name]!;
  const requestHeaders = Object.fromEntries(Object.entries(raw.requestHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    op: raw.op,
    api,
    action: exchangeAction(api, raw.method, url.pathname),
    method: raw.method,
    host: url.hostname,
    path: url.pathname,
    requestHeaderNames: Object.keys(requestHeaders).sort(),
    requestContentType: requestHeaders['content-type'] ?? null,
    requestBodyKeys: keyPaths(parseJson(raw.requestBody)),
    status: raw.status,
    responseHeaderNames: Object.keys(headers).map((k) => k.toLowerCase()).sort(),
    responseHeaders: kept,
    responseBody: parseJson(raw.responseBody),
    ...(raw.fetchError ? { fetchError: raw.fetchError } : {}),
  };
}

/** Response and request fields whose values identify a client, a token or a key, with their placeholder stems. */
const SECRET_FIELDS: Record<string, string> = {
  fid: 'fid',
  refreshToken: 'refresh-token',
  endpoint: 'push-endpoint',
  p256dh: 'push-p256dh',
  auth: 'push-auth',
  applicationPubKey: 'vapid-key',
};

/**
 * Register every identifying value in a request or response body with the
 * redactor: FIDs, refresh tokens, Installations auth tokens, registration
 * tokens, push endpoints and keys. Numbered per kind, in the order first seen.
 */
export class SecretCollector {
  private readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();

  constructor(readonly redactor: Redactor) {}

  /** Values shorter than this are not identifiers and would rewrite ordinary words. */
  static readonly MIN_LENGTH = 8;

  add(value: string, stem: string): void {
    if (value.length < SecretCollector.MIN_LENGTH || this.seen.has(value)) return;
    this.seen.add(value);
    const n = (this.counts.get(stem) ?? 0) + 1;
    this.counts.set(stem, n);
    this.redactor.add(value, `<${stem}-${n}>`);
    const fidPrefix = stem === 'fcm-token' ? value.split(':')[0] : undefined;
    if (fidPrefix && fidPrefix !== value && fidPrefix.length >= 16) this.add(fidPrefix, 'fid');
  }

  walk(value: unknown, api: ExchangeApi | null, parent = ''): void {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        const stem = key === 'token'
          ? (parent === 'authToken' || api === 'installations' ? 'fis-auth-token' : 'fcm-token')
          : SECRET_FIELDS[key];
        if (stem) this.add(child, stem);
      } else {
        this.walk(child, api, key);
      }
    }
  }

  exchange(raw: RawExchange): void {
    const api = exchangeApi(raw.url);
    this.walk(parseJson(raw.requestBody), api);
    this.walk(parseJson(raw.responseBody), api);
    const segments = new URL(raw.url).pathname.split('/');
    const registrations = segments.indexOf('registrations');
    if (registrations !== -1 && segments[registrations + 1]) this.add(decodeURIComponent(segments[registrations + 1]!), 'fcm-token');
    const installations = segments.indexOf('installations');
    if (installations !== -1 && segments[installations + 1]) this.add(decodeURIComponent(segments[installations + 1]!), 'fid');
  }
}

// ─── Push payloads ────────────────────────────────────────────────────────

/** Leaves whose values the run itself chose, or that are enums; every other leaf becomes its type. */
const KEPT_LEAVES = new Set(['priority']);

/**
 * A payload's key set with its leaves' types. A string leaf under `data` or
 * `notification` keeps its value when the run sent that value; ids, the
 * sender and times become `<string>`.
 */
export function payloadShape(value: unknown, sent: ReadonlySet<string>, path: string[] = []): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((child) => payloadShape(child, sent, path));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = payloadShape((value as Record<string, unknown>)[key], sent, [...path, key]);
    return out;
  }
  if (typeof value === 'string') {
    const underSent = path[0] === 'data' || path[0] === 'notification';
    if ((underSent && sent.has(value)) || KEPT_LEAVES.has(path[path.length - 1] ?? '')) return value;
    return '<string>';
  }
  return `<${typeof value}>`;
}

// ─── Redaction ────────────────────────────────────────────────────────────

export const MESSAGING_CREDENTIAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ...CREDENTIAL_PATTERNS,
  ['FCM registration token', /APA91b[A-Za-z0-9_-]{20,}/g],
  ['push endpoint', /\/fcm\/send\/[A-Za-z0-9_:-]{10,}/g],
  ['Installations auth header', /FIS(?:_v2)?\s+[A-Za-z0-9._-]{20,}/g],
  ['Installations refresh token', /\b\d_[A-Za-z0-9_-]{30,}/g],
  ['service account', /[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com/g],
];

/** Every credential pattern or known secret still present in `text`. */
export function messagingLeaks(text: string, secrets: readonly string[]): string[] {
  const leaks = MESSAGING_CREDENTIAL_PATTERNS.filter(([, pattern]) => new RegExp(pattern.source, pattern.flags).test(text)).map(([label]) => label);
  for (const secret of secrets) if (text.includes(secret)) leaks.push(`a known secret (${secret.length} characters)`);
  return leaks;
}

/** Redact, refuse on any leak, and write the recording as pretty JSON. */
export function writeMessagingRecording(path: string, recording: unknown, redactor: Redactor): void {
  const text = redactor.apply(`${JSON.stringify(recording, null, 2)}\n`);
  const leaks = messagingLeaks(text, redactor.secrets);
  if (leaks.length > 0) throw new Error(`refusing to write the recording: ${leaks.join(', ')} survived redaction`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Redact a line for the console: known secrets, then any token-shaped string. */
export function redactLine(redactor: Redactor, line: string): string {
  let out = redactor.apply(line);
  for (const [label, pattern] of MESSAGING_CREDENTIAL_PATTERNS) out = out.replace(new RegExp(pattern.source, pattern.flags), `<${label}>`);
  return out;
}

export async function withTimeout<T>(label: string, promise: Promise<T>, ms = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
