/**
 * What the two live-mode RTDB captures share (issue #2114): the target
 * instances from env, the oracle credential and web config, the run-scoped
 * rules session, a recording WebSocket for the client SDK, and redaction.
 *
 * Env, matching `capture-rtdb-staging-auth-override.ts`:
 *   PYRIC_STAGING_RTDB        the default instance URL (both captures)
 *   PYRIC_STAGING_RTDB_NAMED  a named instance URL in the same project (capture A)
 *   PYRIC_ORACLE_PROJECT_ID   the oracle project, for Application Default Credentials
 *   PYRIC_ORACLE_FIREBASE_CONFIG  optional web config; else the Management API
 *
 * The credential is the oracle credential the rtdb-climb probes run under
 * (`src/oracle-credential.ts`); nothing here names a project.
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import type { FirebaseOptions } from 'firebase/app';
import { loadOracleServiceAccount, oracleAccessToken, type OracleServiceAccount } from '../../oracle-credential.ts';
import { RTDB_RULES_SCOPE } from '../../oracle-access-token.ts';
import { assertWebConfigProject, webConfigFromEnv } from '../../oracle-run-setup.ts';
import { fetchWithRateLimitRetry } from '../../rtdb-rules-rate-limit.ts';

export const DEFAULT_INSTANCE_VARIABLE = 'PYRIC_STAGING_RTDB';
export const NAMED_INSTANCE_VARIABLE = 'PYRIC_STAGING_RTDB_NAMED';
export const RUN_ROOT = 'pyric-live-capture';
export const DENIED_PATH = 'secret';

export interface LiveInstance {
  label: 'default' | 'named';
  url: string;
  name: string;
  placeholder: string;
}

export interface LiveContext {
  projectId: string;
  webConfig: FirebaseOptions & { projectId: string; apiKey: string };
  serviceAccount: OracleServiceAccount;
  runId: string;
  /** `pyric-live-capture/<run id>`, no leading slash. */
  runPath: string;
}

/** The instance an env variable names, or null when it is unset. */
export function instanceFromEnv(
  env: Record<string, string | undefined>,
  variable: string,
  label: LiveInstance['label'],
): LiveInstance | null {
  const url = (env[variable] ?? '').replace(/\/+$/, '');
  if (url === '') return null;
  return { label, url, name: new URL(url).hostname.split('.')[0]!, placeholder: `<${label}-instance>` };
}

const FIREBASE_API = 'https://firebase.googleapis.com/v1beta1';

async function fetchWebConfig(token: string, projectId: string): Promise<LiveContext['webConfig']> {
  const headers = { Authorization: `Bearer ${token}` };
  const project = encodeURIComponent(projectId);
  const list = await fetch(`${FIREBASE_API}/projects/${project}/webApps`, { headers });
  if (!list.ok) throw new Error(`web app list failed: ${list.status}`);
  const apps = ((await list.json()) as { apps?: Array<{ appId: string }> }).apps ?? [];
  if (apps.length === 0) throw new Error('the oracle project has no web app; run the oracle harness once to create it');
  const config = await fetch(`${FIREBASE_API}/projects/${project}/webApps/${encodeURIComponent(apps[0]!.appId)}/config`, { headers });
  if (!config.ok) throw new Error(`web app config failed: ${config.status}`);
  return (await config.json()) as LiveContext['webConfig'];
}

export async function loadLiveContext(env: Record<string, string | undefined> = process.env): Promise<LiveContext> {
  const serviceAccount = await loadOracleServiceAccount(env);
  const projectId = serviceAccount.project_id;
  const fromEnv = webConfigFromEnv(env);
  if (fromEnv) assertWebConfigProject(fromEnv, projectId);
  const webConfig = fromEnv
    ? { ...fromEnv }
    : await fetchWebConfig(await oracleAccessToken(serviceAccount, 'https://www.googleapis.com/auth/firebase'), projectId);
  delete webConfig.databaseURL;
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return { projectId, webConfig, serviceAccount, runId, runPath: `${RUN_ROOT}/${runId}` };
}

// ─── Admin REST against one instance ──────────────────────────────────────

export interface AdminRest {
  request(method: string, path: string, body?: string, query?: string): Promise<{ status: number; text: string }>;
}

export function adminRest(instance: LiveInstance, ctx: LiveContext): AdminRest {
  return {
    async request(method, path, body, query = '') {
      const token = await oracleAccessToken(ctx.serviceAccount, RTDB_RULES_SCOPE);
      const separator = query === '' ? '?' : `${query}&`;
      const url = `${instance.url}/${path}.json${separator}access_token=${encodeURIComponent(token)}`;
      const label = `[rtdb-live] ${method} ${path === '.settings/rules' ? 'rules' : 'data'}`;
      const response = await fetchWithRateLimitRetry(url, { method, body }, label, { logPrefix: '[rtdb-live]', timeoutMs: 30_000 });
      return { status: response.status, text: await response.text() };
    },
  };
}

export interface RunInvariants {
  dataRemoved: boolean;
  rulesRestored: boolean;
}

/**
 * The prior rules with two additions: the run path, readable and writable by
 * any signed-in user, and `/secret`, denied. Refuses a ruleset that already
 * uses either key, or that the endpoint did not return as plain JSON.
 */
export function captureRules(priorText: string, runId: string): { rules: Record<string, unknown> } {
  let prior: { rules?: Record<string, unknown> };
  try {
    prior = JSON.parse(priorText) as { rules?: Record<string, unknown> };
  } catch {
    throw new Error('refusing: the instance rules are not plain JSON, so the capture cannot add its paths to them');
  }
  const rules = prior.rules ?? {};
  for (const key of [RUN_ROOT, DENIED_PATH]) {
    if (key in rules) throw new Error(`refusing: the instance rules already declare /${key}`);
  }
  return {
    rules: {
      ...rules,
      [RUN_ROOT]: { [runId]: { '.read': 'auth != null', '.write': 'auth != null' } },
      [DENIED_PATH]: { '.read': false, '.write': false },
    },
  };
}

export interface CaptureRulesOptions {
  /**
   * Stops every client before cleanup starts (goOffline, deleteUser,
   * deleteApp, any child process), so no queued onDisconnect or in-flight
   * write lands after the run path is removed. A failure is logged, not thrown.
   */
  shutdown?: () => Promise<void>;
  /** Wait after shutdown for the server to run any queued onDisconnect write. */
  settleMs?: number;
  /** Install SIGINT and SIGTERM handlers that run the same cleanup once, then exit. */
  handleSignals?: boolean;
}

export interface CaptureRulesResult<T> {
  result?: T;
  error?: Error;
  invariants: RunInvariants;
}

/**
 * Snapshot the instance's rules, deploy `captureRules`, run `body`, then
 * remove the run path, restore the exact prior rules text and read both back.
 * The invariants are reported whether or not `body` threw.
 */
export function withCaptureRules<T>(
  instance: LiveInstance,
  ctx: LiveContext,
  body: () => Promise<T>,
  options: CaptureRulesOptions = {},
): Promise<CaptureRulesResult<T>> {
  return runWithCaptureRules(instance.label, adminRest(instance, ctx), ctx, body, options);
}

type RestAnswer = { status: number; text: string };

async function attempt(failures: string[], step: string, task: () => Promise<RestAnswer>): Promise<RestAnswer | null> {
  try {
    return await task();
  } catch (e) {
    failures.push(`${step}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * The cleanup after a run. Every step runs whatever the earlier ones did, so a
 * failed DELETE or token fetch still restores the rules. A failed step is an
 * invariant failure, never a throw.
 */
export async function cleanupCaptureRun(
  label: string,
  rest: AdminRest,
  runPath: string,
  priorRules: string,
  options: Pick<CaptureRulesOptions, 'shutdown' | 'settleMs'> = {},
): Promise<RunInvariants> {
  const failures: string[] = [];
  if (options.shutdown) {
    try {
      await options.shutdown();
    } catch (e) {
      failures.push(`shutdown: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (options.settleMs) await pause(options.settleMs);
  const removed = await attempt(failures, 'remove run path', () => rest.request('DELETE', runPath));
  const restored = await attempt(failures, 'restore rules', () => rest.request('PUT', '.settings/rules', priorRules));
  const rulesBack = await attempt(failures, 'read rules back', () => rest.request('GET', '.settings/rules'));
  const dataBack = await attempt(failures, 'read run path back', () => rest.request('GET', runPath, undefined, '?shallow=true'));
  const invariants = {
    dataRemoved: removed?.status === 200 && dataBack?.status === 200 && dataBack.text === 'null',
    rulesRestored: restored?.status === 200 && rulesBack?.status === 200 && rulesBack.text === priorRules,
  };
  if (!invariants.dataRemoved || !invariants.rulesRestored || failures.length > 0) {
    console.error(`[rtdb-live] ${label}: invariant failed`, invariants, {
      removeStatus: removed?.status ?? null,
      restoreStatus: restored?.status ?? null,
      failures,
    });
    console.error(`[rtdb-live] ${label}: read the rules and the run path back by hand.`);
  }
  return invariants;
}

/** `withCaptureRules` with the admin REST calls passed in; tests supply a fake. */
export async function runWithCaptureRules<T>(
  label: string,
  rest: AdminRest,
  run: Pick<LiveContext, 'runId' | 'runPath'>,
  body: () => Promise<T>,
  options: CaptureRulesOptions = {},
): Promise<CaptureRulesResult<T>> {
  const prior = await rest.request('GET', '.settings/rules');
  if (prior.status !== 200) throw new Error(`${label}: cannot read rules: ${prior.status}`);
  const existing = await rest.request('GET', run.runPath, undefined, '?shallow=true');
  if (existing.text !== 'null') throw new Error(`${label}: refusing: the run path already holds data`);
  const deploy = JSON.stringify(captureRules(prior.text, run.runId));

  let cleanup: Promise<RunInvariants> | undefined;
  const cleanupOnce = () => (cleanup ??= cleanupCaptureRun(label, rest, run.runPath, prior.text, options));
  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`[rtdb-live] ${label}: ${signal}; cleaning up before exit.`);
    void cleanupOnce().then((invariants) => process.exit(invariants.dataRemoved && invariants.rulesRestored ? 130 : 3));
  };
  if (options.handleSignals) {
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }

  let result: T | undefined;
  let error: Error | undefined;
  try {
    const dry = await rest.request('PUT', '.settings/rules', deploy, '?dryRun=true');
    if (dry.status !== 200) throw new Error(`${label}: capture rules refused by dry run: ${dry.text.slice(0, 200)}`);
    const put = await rest.request('PUT', '.settings/rules', deploy);
    if (put.status !== 200) throw new Error(`${label}: capture rules deploy failed: ${put.status}`);
    result = await body();
  } catch (e) {
    error = e instanceof Error ? e : new Error(String(e));
  }
  const invariants = await cleanupOnce();
  if (options.handleSignals) {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return { result, error, invariants };
}

// ─── Recording WebSocket ──────────────────────────────────────────────────

export interface RecordedConnection {
  id: number;
  client: string;
  url: string;
  openedAtMs: number | null;
  closedAtMs: number | null;
}

export interface RecordedFrame {
  t: number;
  dir: 'sent' | 'received';
  client: string;
  connection: number;
  op: string;
  data: string;
}

/**
 * Collects every frame the SDK's sockets send and receive, stamped with the
 * milliseconds since the recorder started and the operation running then.
 */
export class WireRecorder {
  readonly start = performance.now();
  readonly connections: RecordedConnection[] = [];
  readonly frames: RecordedFrame[] = [];
  op = 'connect';
  client = 'client-1';

  now(): number {
    return Math.round((performance.now() - this.start) * 10) / 10;
  }

  open(url: string): RecordedConnection {
    const connection = { id: this.connections.length + 1, client: this.client, url, openedAtMs: null, closedAtMs: null };
    this.connections.push(connection);
    return connection;
  }

  frame(connection: RecordedConnection, dir: RecordedFrame['dir'], data: string): void {
    this.frames.push({ t: this.now(), dir, client: connection.client, connection: connection.id, op: this.op, data });
  }

  /** Bytes per direction for the frames of one operation. */
  bytes(op: string): { sent: number; received: number } {
    const total = { sent: 0, received: 0 };
    for (const frame of this.frames) {
      if (frame.op === op) total[frame.dir] += Buffer.byteLength(frame.data);
    }
    return total;
  }
}

type SocketHandler = ((event: unknown) => void) | null;

interface FayeSocket {
  onopen: SocketHandler;
  onclose: SocketHandler;
  onerror: SocketHandler;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): boolean;
  close(): void;
}

type FayeClient = new (url: string, protocols: unknown, options: unknown) => FayeSocket;

/**
 * Swap faye-websocket's `Client`, the constructor the Node build of
 * `@firebase/database` takes at load time, for one that records each frame and
 * forwards to the real socket. Call before the first import of
 * `firebase/database`; returns that module.
 */
export async function importRecordedDatabase(recorder: WireRecorder): Promise<typeof import('firebase/database')> {
  const fromFirebase = createRequire(import.meta.resolve('firebase/database'));
  const fromDatabase = createRequire(fromFirebase.resolve('@firebase/database'));
  const faye = fromDatabase('faye-websocket') as { Client: FayeClient };
  const Real = faye.Client;
  class RecordingSocket {
    onopen: SocketHandler = null;
    onclose: SocketHandler = null;
    onerror: SocketHandler = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    private readonly socket: FayeSocket;
    private readonly connection: RecordedConnection;
    constructor(url: string, protocols: unknown, options: unknown) {
      this.connection = recorder.open(url);
      this.socket = new Real(url, protocols, options);
      this.socket.onopen = (event) => {
        this.connection.openedAtMs = recorder.now();
        this.onopen?.(event);
      };
      this.socket.onmessage = (event) => {
        recorder.frame(this.connection, 'received', String(event.data));
        this.onmessage?.(event);
      };
      this.socket.onclose = (event) => {
        this.connection.closedAtMs = recorder.now();
        this.onclose?.(event);
      };
      this.socket.onerror = (event) => this.onerror?.(event);
    }
    send(data: string): boolean {
      recorder.frame(this.connection, 'sent', data);
      return this.socket.send(data);
    }
    close(): void {
      this.socket.close();
    }
  }
  faye.Client = RecordingSocket;
  const database = await import('firebase/database');
  if (recorder.connections.length !== 0) throw new Error('firebase/database opened a socket before the recorder was in place');
  return database;
}

// ─── Redaction ────────────────────────────────────────────────────────────

export const CREDENTIAL_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]*)?/g],
  ['OAuth access token', /ya29\.[A-Za-z0-9_-]{10,}/g],
  ['API key', /AIza[0-9A-Za-z_-]{30,}/g],
  ['Firebase refresh token', /AMf-v[A-Za-z0-9_-]{20,}/g],
  ['Google refresh token', /1\/\/0[A-Za-z0-9_-]{20,}/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['bearer header', /Bearer\s+[A-Za-z0-9._-]{20,}/gi],
  ['access_token query', /access_token=[^&"<]{10,}/g],
];

/** Fixed replacements first (longest first), then any token-shaped string left. */
export class Redactor {
  private readonly pairs: Array<[string, string]> = [];

  add(secret: string | undefined | null, placeholder: string): void {
    if (!secret || this.pairs.some(([s]) => s === secret)) return;
    this.pairs.push([secret, placeholder]);
    this.pairs.sort((a, b) => b[0].length - a[0].length);
  }

  get secrets(): string[] {
    return this.pairs.map(([secret]) => secret);
  }

  apply(text: string): string {
    let out = text;
    for (const [secret, placeholder] of this.pairs) out = out.split(secret).join(placeholder);
    out = out.replace(/([?&])(ls|p)=[^&"\\]+/g, (_m, sep: string, key: string) => `${sep}${key}=<${key === 'ls' ? 'session' : 'app-id'}>`);
    out = out.replace(/("t":"h","d":\{[^}]*"s":")[^"]+/g, '$1<session>');
    out = out.replace(/(\\"t\\":\\"h\\",\\"d\\":\{[^}]*\\"s\\":\\")[^"\\]+/g, '$1<session>');
    out = out.replace(CREDENTIAL_PATTERNS[0]![1], '<id-token>');
    out = out.replace(CREDENTIAL_PATTERNS[1]![1], '<access-token>');
    return out;
  }
}

/** Every credential pattern or known secret still present in `text`. */
export function credentialLeaks(text: string, secrets: readonly string[]): string[] {
  const leaks = CREDENTIAL_PATTERNS.filter(([, pattern]) => new RegExp(pattern.source, pattern.flags).test(text)).map(([label]) => label);
  for (const secret of secrets) if (text.includes(secret)) leaks.push(`a known secret (${secret.length} characters)`);
  return leaks;
}

/** Redact, refuse on any leak, and write the recording as pretty JSON. */
export function writeRecording(path: string, recording: unknown, redactor: Redactor): void {
  const text = redactor.apply(`${JSON.stringify(recording, null, 2)}\n`);
  const leaks = credentialLeaks(text, redactor.secrets);
  if (leaks.length > 0) throw new Error(`refusing to write ${path}: ${leaks.join(', ')} survived redaction`);
  writeFileSync(path, text);
}

export function redactorFor(ctx: LiveContext, instances: LiveInstance[]): Redactor {
  const redactor = new Redactor();
  for (const instance of instances) redactor.add(instance.name, instance.placeholder);
  redactor.add(ctx.webConfig.apiKey, '<api-key>');
  redactor.add(ctx.webConfig.appId, '<app-id>');
  redactor.add(ctx.runId, '<run>');
  redactor.add(ctx.projectId, '<project>');
  return redactor;
}

export async function withTimeout<T>(label: string, promise: Promise<T>, ms = 20_000): Promise<T> {
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
