/**
 * Replay a repro file against a fresh host and report where it diverges.
 *
 * Two planes run the same host dispatch: `node`, the Node host
 * `pyric sandbox` and the Vite plugin start, with its SQLite persistence in a
 * temporary directory; and `worker`, the SharedWorker host the page runs,
 * booted through the worker's own boot path with an in-memory store. Each
 * plane starts from the repro's starting state, receives the recorded frames
 * in the recorded order, one at a time, and has its results and listener
 * events compared with the recorded ones. The report names the first
 * divergence on each plane and every frame where the two planes disagree.
 *
 * Replay is sequential: each frame is handled to completion before the next
 * is sent. A failure that depends on two ports' operations interleaving shows
 * up as a divergence at the first frame whose result differs.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InitPayload } from '../init-payload.js';
import type { InboundMessage, OutboundMessage } from '../worker/protocol.js';
import type { PortLike } from '../worker/host-context.js';
import { IdBindings, matchRecorded, canonical } from './compare.js';
import { parseRepro, redactSecrets, restoreRedactedTokens, type ReproBase, type ReproEntry, type ReproFile } from './format.js';

export type ReplayPlaneName = 'node' | 'worker';

/** The recorded operation a divergent frame answers. */
export interface ReplayOperation {
  method?: string;
  instance?: string;
  path?: string;
  subId?: string;
}

export interface ReplayDivergence {
  /** Index of the recorded entry in `entries`. */
  entry: number;
  session: string;
  kind: 'result' | 'event';
  /** The operation or listener the frame belongs to. */
  operation: ReplayOperation;
  reason: 'differs' | 'missing';
  expected: unknown;
  actual: unknown;
}

export interface ReplayPlaneReport {
  plane: ReplayPlaneName;
  ok: boolean;
  /** Recorded results and events compared. */
  checked: number;
  firstDivergence: ReplayDivergence | null;
  /** At most {@link MAX_REPORTED} divergences, in recorded order. */
  divergences: ReplayDivergence[];
}

export interface ReplayPlaneDifference {
  entry: number;
  session: string;
  kind: 'result' | 'event';
  operation: ReplayOperation;
  node: unknown;
  worker: unknown;
}

export interface ReproReplayReport {
  ok: boolean;
  planes: Partial<Record<ReplayPlaneName, ReplayPlaneReport>>;
  /** Frames where the planes produced different results. Empty with one plane. */
  planeDifferences: ReplayPlaneDifference[];
  /** Recorded changes replay cannot reproduce, such as a command that wrote state. */
  warnings: string[];
}

export interface ReplayReproOptions {
  /** Planes to replay on. Defaults to both. */
  planes?: ReplayPlaneName[];
  /** How long to wait for one recorded result or event, in milliseconds. */
  frameTimeoutMs?: number;
}

const MAX_REPORTED = 50;
const SETUP_SESSION = '__repro_setup';

interface Plane {
  send(session: string, frame: InboundMessage): void;
  /** Frames the host sent a session since the plane started. */
  received(session: string): OutboundMessage[];
  deployRules(service: 'firestore' | 'database' | 'storage', source: unknown, instance?: string): Promise<void>;
  close(): Promise<void>;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor<T>(find: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** The project configuration a plane boots with, as `/__pyric/init.json` would carry it. */
function payloadFor(base: ReproBase, projectKey: string, hosted: boolean): InitPayload {
  const declared: Record<string, { rules: Record<string, unknown> }> = {};
  for (const [name, rules] of Object.entries(base.rules.database)) if (rules) declared[name] = rules;
  return {
    rules: base.rules.firestore, rulesHash: null,
    storageRules: base.rules.storage, storageRulesHash: null,
    databaseInstances: { defaultInstance: base.defaultInstance, rules: declared },
    permissive: base.permissive,
    bridgeUrl: null, seed: null, capture: false, hosted, projectKey,
  };
}

async function installIndexedDb(): Promise<void> {
  const hasIndexedDb = typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
  if (hasIndexedDb) return;
  const fake = await import('fake-indexeddb');
  Object.assign(globalThis, { indexedDB: fake.indexedDB, IDBKeyRange: fake.IDBKeyRange });
}

function collector() {
  const frames = new Map<string, OutboundMessage[]>();
  return {
    push(session: string, frame: OutboundMessage) {
      let list = frames.get(session);
      if (!list) {
        list = [];
        frames.set(session, list);
      }
      list.push(frame);
    },
    received(session: string): OutboundMessage[] {
      return frames.get(session) ?? [];
    },
  };
}

async function startNodePlane(base: ReproBase): Promise<Plane> {
  const { createHostedRuntime } = await import('../hosted/runtime.js');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'pyric-repro-')));
  const frames = collector();
  let runtime: Awaited<ReturnType<typeof createHostedRuntime>>;
  try {
    runtime = await createHostedRuntime(payloadFor(base, directory, true), 'http://127.0.0.1:1', (message) => {
      const isWorkerReply = message.type === 'worker-message-result' && message.clientSessionId !== undefined;
      if (isWorkerReply) frames.push(message.clientSessionId as string, message.message);
    }, directory, { record: false });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    send(session, frame) {
      runtime.receive({ type: 'worker-message', clientSessionId: session, message: frame });
    },
    received: frames.received,
    async deployRules(service, source, instance) {
      await runtime.deployRules(service, source === null ? null : typeof source === 'string' ? source : JSON.stringify(source), instance);
    },
    async close() {
      try {
        await runtime.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

async function startWorkerPlane(base: ReproBase): Promise<Plane> {
  await installIndexedDb();
  const [{ buildWorkerCtx }, { handleMessage }, { setDatabaseRules, handleRulesOp }, { createMemoryBackend }, { replaceStorageRules }, { normalizeDatabaseRules }] = await Promise.all([
    import('../worker/serve-init.js'),
    import('../worker/host.js'),
    import('../worker/host/rules.js'),
    import('pyric/sandbox'),
    import('pyric/storage/internal'),
    import('../worker/host/rules.js'),
  ]);
  const payload = payloadFor(base, `pyric-repro-${crypto.randomUUID()}`, false);
  const fetchInit = (async (input: Parameters<typeof fetch>[0]) => {
    const isInit = String(input) === '/__pyric/init.json';
    return isInit ? Response.json(payload) : new Response(null, { status: 404 });
  }) as typeof fetch;
  const ctx = await buildWorkerCtx({ fetch: fetchInit, idb: createMemoryBackend(), makeEventSource: null });
  const frames = collector();
  const ports = new Map<string, { port: PortLike; pending: Promise<void> }>();
  function portFor(session: string) {
    let owned = ports.get(session);
    if (!owned) {
      owned = { port: { postMessage: (message: OutboundMessage) => frames.push(session, message) }, pending: Promise.resolve() };
      ports.set(session, owned);
    }
    return owned;
  }
  return {
    send(session, frame) {
      const owned = portFor(session);
      owned.pending = owned.pending.then(() => handleMessage(ctx, owned.port, frame)).catch(() => {});
    },
    received: frames.received,
    async deployRules(service, source, instance) {
      if (service === 'storage') {
        await replaceStorageRules(ctx.sandbox, typeof source === 'string' ? source : null);
      } else if (service === 'database') {
        setDatabaseRules(ctx, instance, normalizeDatabaseRules(source));
      } else if (typeof source === 'string') {
        handleRulesOp(ctx, { postMessage() {} }, { t: 'op', id: 'repro-rules', method: 'setFirestoreRules', source }, ctx.db);
      }
    },
    async close() {
      ctx.sandbox.dispose();
    },
  };
}

/** Send one frame and wait for its result, or for the host to go quiet after a frame without one. */
async function sendAndWait(plane: Plane, session: string, frame: InboundMessage, timeoutMs: number): Promise<OutboundMessage | undefined> {
  plane.send(session, frame);
  const answers = frame.t === 'op' || frame.t === 'tool';
  let result: OutboundMessage | undefined;
  if (answers) {
    const id = frame.id;
    result = await waitFor(() => plane.received(session).find((reply) => reply.t === 'res' && reply.id === id), timeoutMs);
  }
  await settle();
  return result;
}

/** Put a plane in the starting state: data, rules, signed-in ports and open listeners. */
async function applyBase(plane: Plane, base: ReproBase, timeoutMs: number): Promise<void> {
  let sequence = 0;
  const setup = async (session: string, frame: Record<string, unknown>): Promise<void> => {
    const id = `repro-setup-${++sequence}`;
    const reply = await sendAndWait(plane, session, { t: 'op', id, ...frame } as InboundMessage, timeoutMs);
    const succeeded = reply?.t === 'res' && reply.ok;
    if (!succeeded) {
      const error = reply?.t === 'res' && !reply.ok ? reply.error.message : 'no reply';
      throw new Error(`Replay could not apply the starting state (${String(frame.method)}): ${error}`);
    }
  };
  if (base.appOptions) {
    for (const session of [SETUP_SESSION, ...Object.keys(base.sessions)]) {
      plane.send(session, { t: 'appConfig', options: base.appOptions } as unknown as InboundMessage);
    }
    await settle();
  }
  await setup(SETUP_SESSION, { method: 'importState', bundle: JSON.stringify(base.checkpoint) });
  // A state import resets every instance's rules, so they are deployed again after it.
  for (const [instance, rules] of Object.entries(base.rules.database)) {
    if (rules) await setup(SETUP_SESSION, { method: 'setDatabaseRules', instance, source: rules });
  }
  for (const [instance, tree] of Object.entries(base.databaseInstances)) {
    await setup(SETUP_SESSION, { method: 'rtdb.set', instance, path: '/', value: tree, actAs: { mode: 'admin' } });
  }
  if (base.rules.firestore !== null) await setup(SETUP_SESSION, { method: 'setFirestoreRules', source: base.rules.firestore });
  for (const [session, identity] of Object.entries(base.sessions)) {
    await setup(session, { method: 'auth.restorePortSession', uid: identity.uid, tenantId: identity.tenantId });
  }
  for (const [session, subscriptions] of Object.entries(base.subscriptions)) {
    for (const frame of subscriptions) plane.send(session, restoreRedactedTokens(frame) as InboundMessage);
  }
  await settle();
}

function describe(frame: InboundMessage | undefined): ReplayOperation {
  if (!frame) return {};
  const record = frame as unknown as Record<string, unknown>;
  const operation: ReplayOperation = {};
  if (typeof record.method === 'string') operation.method = record.method;
  if (frame.t === 'tool') operation.method = `tool:${frame.name}`;
  if (typeof record.instance === 'string') operation.instance = record.instance;
  if (typeof record.path === 'string') operation.path = record.path;
  if (frame.t === 'sub') {
    operation.subId = frame.subId;
    const target = record.target as Record<string, unknown> | string | undefined;
    if (typeof target === 'string') operation.method = `listen:${target}`;
    else if (target && typeof target === 'object') {
      if (typeof target.path === 'string') operation.path = target.path;
      if (typeof target.instance === 'string') operation.instance = target.instance;
      operation.method = target.service === 'rtdb' ? 'listen:rtdb' : 'listen:firestore';
    }
  }
  return operation;
}

/** A frame as it is compared: secrets removed, the session id it travelled under dropped. */
function comparable(frame: OutboundMessage): unknown {
  const { clientSessionId: _session, ...rest } = frame;
  return redactSecrets(JSON.parse(JSON.stringify(rest)));
}

interface PlaneRun {
  report: ReplayPlaneReport;
  /** Each compared entry's observed value, in the recording's ids. */
  observed: Map<number, unknown>;
}

async function replayOn(name: ReplayPlaneName, file: ReproFile, timeoutMs: number): Promise<PlaneRun> {
  const plane = name === 'node' ? await startNodePlane(file.base) : await startWorkerPlane(file.base);
  const divergences: ReplayDivergence[] = [];
  const observed = new Map<number, unknown>();
  let checked = 0;
  let total = 0;
  try {
    await applyBase(plane, file.base, timeoutMs);
    // Frames sent while the starting state was applied are not part of the log.
    const offsets = new Map<string, number>();
    const offsetOf = (session: string): number => {
      let offset = offsets.get(session);
      if (offset === undefined) {
        offset = plane.received(session).length;
        offsets.set(session, offset);
      }
      return offset;
    };
    for (const session of new Set([...Object.keys(file.base.subscriptions), ...Object.keys(file.base.sessions)])) offsetOf(session);
    const bindings = new IdBindings();
    const sentById = new Map<string, InboundMessage>();
    const subscriptionFrames = new Map<string, InboundMessage>();
    for (const [session, subs] of Object.entries(file.base.subscriptions)) {
      for (const frame of subs) if (frame.t === 'sub') subscriptionFrames.set(`${session}\u0000${frame.subId}`, frame);
    }
    const eventsSeen = new Map<string, number>();
    for (const [index, entry] of file.entries.entries()) {
      if (entry.kind === 'rules') {
        await plane.deployRules(entry.service, entry.source, entry.instance);
        continue;
      }
      if (entry.kind === 'external') continue;
      if (entry.kind === 'in') {
        offsetOf(entry.session);
        const frame = restoreRedactedTokens(bindings.toReplay(entry.frame)) as InboundMessage;
        if ('id' in entry.frame) sentById.set(`${entry.session}\u0000${entry.frame.id}`, entry.frame);
        if (entry.frame.t === 'sub') subscriptionFrames.set(`${entry.session}\u0000${entry.frame.subId}`, entry.frame);
        await sendAndWait(plane, entry.session, frame, timeoutMs);
        continue;
      }
      const recorded = entry.frame;
      const offset = offsetOf(entry.session);
      let actual: OutboundMessage | undefined;
      let operation: ReplayOperation;
      let kind: 'result' | 'event';
      if (recorded.t === 'res') {
        kind = 'result';
        operation = describe(sentById.get(`${entry.session}\u0000${recorded.id}`));
        const wasSent = sentById.has(`${entry.session}\u0000${recorded.id}`);
        // A result for an operation sent before the log began has nothing to compare against.
        if (!wasSent) continue;
        actual = await waitFor(() => plane.received(entry.session).slice(offset).find((reply) => reply.t === 'res' && reply.id === recorded.id), timeoutMs);
      } else if (recorded.t === 'snap') {
        kind = 'event';
        const key = `${entry.session}\u0000${recorded.subId}`;
        operation = describe(subscriptionFrames.get(key));
        const position = eventsSeen.get(key) ?? 0;
        eventsSeen.set(key, position + 1);
        actual = await waitFor(() => plane.received(entry.session).slice(offset)
          .filter((event) => event.t === 'snap' && event.subId === recorded.subId)[position], timeoutMs);
      } else {
        continue;
      }
      total++;
      const expected = comparable(recorded);
      if (actual === undefined) {
        observed.set(index, { missing: true });
        if (divergences.length < MAX_REPORTED) {
          divergences.push({ entry: index, session: entry.session, kind, operation, reason: 'missing', expected, actual: null });
        }
        continue;
      }
      checked++;
      const comparison = matchRecorded(expected, comparable(actual), bindings);
      observed.set(index, comparison.observed);
      const differs = !comparison.matches;
      if (differs && divergences.length < MAX_REPORTED) {
        divergences.push({ entry: index, session: entry.session, kind, operation, reason: 'differs', expected, actual: comparison.observed });
      }
    }
  } finally {
    await plane.close();
  }
  return {
    report: { plane: name, ok: divergences.length === 0 && checked === total, checked, firstDivergence: divergences[0] ?? null, divergences },
    observed,
  };
}

/** Recorded changes the replay cannot make. */
function warningsFor(file: ReproFile): string[] {
  const warnings: string[] = [];
  const external = file.entries.filter((entry): entry is Extract<ReproEntry, { kind: 'external' }> => entry.kind === 'external');
  for (const entry of external) {
    warnings.push(`'${entry.name}' changed state outside the application's connections at ${new Date(entry.at).toISOString()}; replay does not run it.`);
  }
  if (file.truncated) warnings.push('The log is bounded and older entries were dropped; replay starts from the oldest starting state the file keeps.');
  return warnings;
}

/**
 * Replay a repro file on a fresh Node host and a fresh worker host, and report
 * the first divergence from the recording on each and every difference
 * between them. Accepts a parsed file or its JSON value.
 */
export async function replayRepro(repro: ReproFile | unknown, options: ReplayReproOptions = {}): Promise<ReproReplayReport> {
  const file = parseRepro(repro);
  const planes = options.planes ?? ['node', 'worker'];
  const timeoutMs = options.frameTimeoutMs ?? 2000;
  const runs: Partial<Record<ReplayPlaneName, PlaneRun>> = {};
  for (const plane of planes) runs[plane] = await replayOn(plane, file, timeoutMs);
  const planeDifferences: ReplayPlaneDifference[] = [];
  const node = runs.node;
  const worker = runs.worker;
  if (node && worker) {
    for (const [index, entry] of file.entries.entries()) {
      if (entry.kind !== 'out') continue;
      const fromNode = node.observed.get(index);
      const fromWorker = worker.observed.get(index);
      const bothCompared = node.observed.has(index) || worker.observed.has(index);
      const differs = bothCompared && canonical(fromNode) !== canonical(fromWorker);
      if (differs && planeDifferences.length < MAX_REPORTED) {
        const divergence = node.report.divergences.find((item) => item.entry === index)
          ?? worker.report.divergences.find((item) => item.entry === index);
        planeDifferences.push({
          entry: index, session: entry.session, kind: entry.frame.t === 'res' ? 'result' : 'event',
          operation: divergence?.operation ?? {}, node: fromNode ?? null, worker: fromWorker ?? null,
        });
      }
    }
  }
  const reports: Partial<Record<ReplayPlaneName, ReplayPlaneReport>> = {};
  for (const [plane, run] of Object.entries(runs)) reports[plane as ReplayPlaneName] = run.report;
  const ok = Object.values(reports).every((report) => report.ok) && planeDifferences.length === 0;
  return { ok, planes: reports, planeDifferences, warnings: warningsFor(file) };
}
