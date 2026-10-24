/**
 * The staging engine: `pyric verify --engine staging` replays a captured RTDB
 * session against a real Realtime Database instance the user dedicates to it,
 * so production's rules engine decides every operation.
 *
 * It walks the same steps as the sandbox replay (`rtdbReplaySteps`), in order,
 * performing each against the instance through the REST API as the captured
 * user (`auth_variable_override`) or as admin:
 *
 * - `admin-commit`: written as admin, as context.
 * - `app-commit`: written as the user; a denial is `now-denied`.
 * - `allowed-read`: read as the user, with its query; a denial is `now-denied`.
 * - `denial`: attempted as the user; success is `now-allowed`, and a write
 *   that landed is put back as admin, so the tree stays the session's.
 * - `allowed-registration`: the `onDisconnect` write it registers, attempted
 *   as the user and put back (production decides a registration as that
 *   write when it is made, row M81); a denial is `now-denied`.
 *
 * Then the tree is compared with the one the session left (`state-drift`).
 *
 * The instance is the user's, so every run is guarded (`withStagingInstance`):
 * it must carry the enrollment marker `pyric verify staging init` wrote and
 * hold no data; the run takes a lease (a conditional write of
 * `/__pyric_verify_lease__`, so a second run is refused); on every exit,
 * including an aborted walk, its rules are restored and its data deleted,
 * each step on its own and retried, then both are read back, and a run that
 * cannot prove that fails loudly, naming `pyric verify staging restore`.
 * A process killed outright (SIGKILL, power loss) cannot clean up; the CLI
 * keeps the prior rules in `.pyric/staging-restore.json` for that command.
 */
import type { SandboxCommitEvent, SandboxEvent, SandboxOperationEvent } from 'pyric/sandbox';
import {
  rewoundRtdbTree,
  rtdbAuthVariable,
  rtdbReplaySteps,
  rtdbStateDrift,
  type RtdbReplayDivergence,
} from 'pyric/rules/internal/rtdb';

import { isRestDenial, type RtdbAuthOverride, type RtdbRestClient, type RtdbRestResponse } from './rest.js';

/** The comment `pyric verify staging init` puts at the top of the instance's rules. */
export const STAGING_MARKER_PREFIX = '/* pyric verify staging:';

export function stagingMarker(projectId: string, at = new Date()): string {
  return `${STAGING_MARKER_PREFIX} this instance is dedicated to \`pyric verify --engine staging\` for project ${projectId}, enrolled ${at.toISOString()}. Its rules and data are replaced while a verification runs. */`;
}

/** The project an enrollment marker names, or undefined when the rules carry no marker. */
export function markedProject(rulesText: string): string | undefined {
  const trimmed = rulesText.trimStart();
  if (!trimmed.startsWith(STAGING_MARKER_PREFIX)) return undefined;
  return /for project ([^\s,]+),/.exec(trimmed.slice(0, trimmed.indexOf('*/') + 2))?.[1];
}

export class StagingSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingSafetyError';
  }
}

/** Production refused to deploy the candidate rules; its message is the reason. */
export class StagingDeployRefusedError extends Error {
  constructor(readonly instanceLabel: string, readonly production: string) {
    super(`production refused to deploy the candidate rules for ${instanceLabel}: ${production}`);
    this.name = 'StagingDeployRefusedError';
  }
}

/** What a guarded run found when it put the instance back. */
export interface StagingInvariants {
  rulesRestored: boolean;
  dataRemoved: boolean;
}

/** The data node a run holds while it runs; written with a conditional request, so only one run gets it. */
export const STAGING_LEASE_KEY = '__pyric_verify_lease__';

/** Hooks a caller can attach to a guarded run. */
export interface StagingRunHooks {
  /** Called with the prior rules text before anything is changed, so the caller can keep it for recovery. */
  onBeforeChange?: (priorRules: string) => void;
  /** Called once the instance reads back as it was found. */
  onRestored?: () => void;
  /** Abort the walk between steps; cleanup still runs. */
  signal?: AbortSignal;
}

/**
 * Run `fn` against the staging instance behind `client`, guarded: refuse an
 * instance without the marker for `projectId`, with data, or with another
 * run's lease; on every exit restore its rules and delete its data, each step
 * attempted on its own and retried, then read both back.
 */
export async function withStagingInstance<T>(
  client: RtdbRestClient,
  projectId: string,
  fn: () => Promise<T>,
  hooks: StagingRunHooks = {},
): Promise<{ result: T; invariants: StagingInvariants }> {
  const priorRules = await client.getRulesText();
  const marked = markedProject(priorRules);
  if (marked === undefined) {
    throw new StagingSafetyError(
      `${client.databaseUrl} is not enrolled for staging verification (its rules do not start with the enrollment marker). ` +
        'Run `pyric verify staging init` once to enroll a dedicated, empty instance. If a verification was interrupted, run `pyric verify staging restore`.',
    );
  }
  if (marked !== projectId) {
    throw new StagingSafetyError(`${client.databaseUrl} is enrolled for project ${marked}, not ${projectId}.`);
  }
  const root = await client.get('/', { shallow: true });
  if (root.status !== 200) throw new StagingSafetyError(`reading ${client.databaseUrl} failed: HTTP ${root.status} ${root.text.slice(0, 200)}`);
  if (root.body !== null) {
    const leased = typeof root.body === 'object' && root.body !== null && STAGING_LEASE_KEY in root.body;
    throw new StagingSafetyError(leased
      ? `another verification holds ${client.databaseUrl} (its lease is set). Wait for it to finish; if none is running, run \`pyric verify staging restore\`.`
      : `${client.databaseUrl} holds data, so it is not a dedicated staging instance. Refusing to replace it.`);
  }
  const lease = { run: `${process.pid}-${Date.now().toString(36)}`, at: new Date().toISOString() };
  const empty = await client.get(STAGING_LEASE_KEY, { etag: true });
  const taken = empty.etag === undefined
    ? { status: 0, text: 'no ETag', body: null }
    : await client.put(STAGING_LEASE_KEY, lease, { ifMatch: empty.etag });
  if (taken.status !== 200) {
    throw new StagingSafetyError(
      taken.status === 412
        ? `another verification took ${client.databaseUrl} first. Run one verification at a time per staging instance.`
        : `taking the lease on ${client.databaseUrl} failed: HTTP ${taken.status} ${String(taken.text).slice(0, 200)}`,
    );
  }

  hooks.onBeforeChange?.(priorRules);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fn() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const invariants = await restoreStagingInstance(client, priorRules);
  if (!invariants.rulesRestored || !invariants.dataRemoved) {
    throw new StagingSafetyError(
      `${client.databaseUrl} was not left as it was found (rules restored: ${invariants.rulesRestored}, data removed: ${invariants.dataRemoved}${invariants.errors.length > 0 ? `; ${invariants.errors.join('; ')}` : ''}). ` +
        'Run `pyric verify staging restore` to put it back.',
    );
  }
  hooks.onRestored?.();
  if (!outcome.ok) throw outcome.error;
  return { result: outcome.value, invariants: { rulesRestored: true, dataRemoved: true } };
}

/**
 * Put a staging instance back: deploy `rulesText` first, since candidate
 * rules may be open, then delete the data; each step on its own, retried,
 * and read back. Never throws: the result says what holds.
 */
export async function restoreStagingInstance(
  client: RtdbRestClient,
  rulesText: string,
): Promise<StagingInvariants & { errors: string[] }> {
  const errors: string[] = [];
  const attempt = async (what: string, step: () => Promise<boolean>): Promise<boolean> => {
    let last = '';
    for (let tries = 0; tries < 3; tries += 1) {
      try {
        if (await step()) return true;
        last = 'did not read back';
      } catch (error) {
        last = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * (tries + 1)));
    }
    errors.push(`${what}: ${last}`);
    return false;
  };
  const rulesRestored = await attempt('restoring the rules', async () => {
    const put = await client.putRules(rulesText);
    return put.status === 200 && (await client.getRulesText()) === rulesText;
  });
  const dataRemoved = await attempt('deleting the data', async () => {
    const removed = await client.delete('/');
    const back = await client.get('/', { shallow: true });
    return removed.status === 200 && back.status === 200 && back.body === null;
  });
  return { rulesRestored, dataRemoved, errors };
}

export interface StagingInstanceRun {
  checkedEvents: number;
  divergences: RtdbReplayDivergence[];
}

/**
 * Replay one captured instance's steps against the staging instance under
 * `rules`. Call inside `withStagingInstance`; the instance must be empty.
 */
export async function runStagingInstance(input: {
  client: RtdbRestClient;
  events: readonly SandboxEvent[];
  rules: { rules: Record<string, unknown> };
  capturedState: unknown;
  /** A named instance; absent is the default instance. */
  instance?: string;
  /** Abort between steps; the guard still cleans up. */
  signal?: AbortSignal;
}): Promise<StagingInstanceRun> {
  const { client, events } = input;
  const label = input.instance === undefined ? 'the default instance' : `instance "${input.instance}"`;
  const source = JSON.stringify(input.rules, null, 2);
  const dry = await client.putRules(source, { dryRun: true });
  if (dry.status !== 200) throw new StagingDeployRefusedError(label, productionMessage(dry));
  const deployed = await client.putRules(source);
  if (deployed.status !== 200) throw new StagingDeployRefusedError(label, productionMessage(deployed));

  const lease = (await expectOk(client.get(STAGING_LEASE_KEY), 'reading the lease')).body;
  if (input.capturedState !== undefined) {
    const initial = await rewoundRtdbTree(events, input.capturedState, input.instance);
    if (initial !== null) await expectOk(client.put('/', withLease(initial, lease)), 'seeding the session\'s starting tree');
  }

  const divergences: RtdbReplayDivergence[] = [];
  let checkedEvents = 0;
  const steps = rtdbReplaySteps(events, input.instance);
  for (const [index, step] of steps.entries()) {
    input.signal?.throwIfAborted();
    const before = divergences.length;
    if (step.kind === 'admin-commit') {
      const res = await writeCommit(client, step.event, undefined, lease);
      if (typeof res === 'string') divergences.push({ kind: 'unsupported', path: pathOf(step.event), method: step.event.method, reason: res });
      else await expectOk(Promise.resolve(res), `the admin ${step.event.method} at ${step.event.path}`);
    } else if (step.kind === 'app-commit') {
      checkedEvents += 1;
      const res = await writeCommit(client, step.event, authOverride(step.event), lease);
      if (typeof res === 'string') divergences.push({ kind: 'unsupported', path: pathOf(step.event), method: step.event.method, reason: res });
      else if (isRestDenial(res.status)) divergences.push(denied(step.event, res));
      else if (res.status !== 200) divergences.push(unsupported(step.event, res));
    } else if (step.kind === 'allowed-read') {
      checkedEvents += 1;
      const query = restQuery(step.event);
      if (typeof query === 'string') {
        divergences.push({ kind: 'unsupported', path: pathOf(step.event), method: step.event.method, reason: query });
      } else {
        const res = await client.get(pathOf(step.event), { auth: authOverride(step.event), query });
        if (isRestDenial(res.status)) divergences.push(denied(step.event, res));
        else if (res.status !== 200) divergences.push(unsupported(step.event, res));
      }
    } else {
      checkedEvents += 1;
      await decide(client, step.event, step.kind === 'denial' ? 'deny' : 'allow', divergences, lease);
    }
    // Each divergence names the replay step it came from, so engines compare step for step.
    for (const divergence of divergences.slice(before)) (divergence as { step?: number }).step = index;
  }

  if (input.capturedState !== undefined) {
    const finalTree = await expectOk(client.get('/'), 'reading the replayed tree');
    divergences.push(...rtdbStateDrift(input.capturedState, withoutLease(finalTree.body)));
  }
  return { checkedEvents, divergences };
}

/** A tree with the run's lease kept at the root, so a root write does not release it. */
function withLease(tree: unknown, lease: unknown): unknown {
  if (lease === null || lease === undefined) return tree;
  if (tree === null || tree === undefined) return { [STAGING_LEASE_KEY]: lease };
  if (!isObject(tree)) return tree;
  return { ...tree, [STAGING_LEASE_KEY]: lease };
}

function withoutLease(tree: unknown): unknown {
  if (!isObject(tree) || !(STAGING_LEASE_KEY in tree)) return tree;
  const { [STAGING_LEASE_KEY]: _lease, ...rest } = tree;
  return Object.keys(rest).length === 0 ? null : rest;
}

/**
 * Attempt a captured denial or registration as its user. A write that lands
 * is put back as admin from the subtree read before it.
 */
async function decide(
  client: RtdbRestClient,
  event: SandboxOperationEvent,
  captured: 'allow' | 'deny',
  divergences: RtdbReplayDivergence[],
  lease: unknown,
): Promise<void> {
  const path = pathOf(event);
  const auth = authOverride(event);
  let res: RtdbRestResponse;
  if (event.method === 'get' || event.method === 'listen') {
    const query = restQuery(event);
    if (typeof query === 'string') {
      divergences.push({ kind: 'unsupported', path, method: event.method, reason: query });
      return;
    }
    res = await client.get(path, { auth, query });
  } else {
    const write = attemptedWrite(event);
    if (typeof write === 'string') {
      divergences.push({ kind: 'unsupported', path, method: event.method, reason: write });
      return;
    }
    const before = await expectOk(client.get(write.restorePath, { format: 'export' }), `reading ${write.restorePath} before the attempt`);
    res = await write.send(client, auth);
    if (res.status === 200) {
      const restored = write.restorePath === '/' ? withLease(before.body, lease) : before.body;
      await expectOk(client.put(write.restorePath, restored), `putting ${write.restorePath} back after the attempt`);
    }
  }
  if (res.status === 200) {
    if (captured === 'deny') {
      divergences.push({
        kind: 'now-allowed',
        path,
        method: event.method,
        reason: 'the captured rules denied this operation; production allows it under the candidate rules.',
      });
    }
  } else if (isRestDenial(res.status)) {
    if (captured === 'allow') divergences.push(denied(event, res));
  } else {
    divergences.push(unsupported(event, res));
  }
}

interface AttemptedWrite {
  /** The subtree read before the attempt and put back after a write that lands. */
  restorePath: string;
  send(client: RtdbRestClient, auth: RtdbAuthOverride): Promise<RtdbRestResponse>;
}

function attemptedWrite(event: SandboxOperationEvent): AttemptedWrite | string {
  const path = pathOf(event);
  const data = event.request?.data;
  const detail = (event.detail ?? {}) as { patch?: unknown; rootPath?: unknown; priority?: unknown };
  switch (event.method) {
    case 'set':
    case 'transaction':
      return { restorePath: path, send: (client, auth) => client.put(path, withPriority(data ?? null, detail.priority), { auth }) };
    case 'onDisconnect.set':
      return { restorePath: path, send: (client, auth) => client.put(path, withPriority(data ?? null, detail.priority), { auth }) };
    case 'remove':
    case 'onDisconnect.remove':
      return { restorePath: path, send: (client, auth) => client.delete(path, { auth }) };
    case 'update':
      if (!isObject(detail.patch) || typeof detail.rootPath !== 'string') {
        return 'the capture records only the denied path of this update, not the paths written with it, so the update cannot be rebuilt.';
      }
      return { restorePath: detail.rootPath, send: (client, auth) => client.patch(detail.rootPath as string, detail.patch, { auth }) };
    case 'onDisconnect.update':
      if (!isObject(data)) return 'the captured onDisconnect update did not contain an object patch.';
      return { restorePath: path, send: (client, auth) => client.patch(path, data, { auth }) };
    case 'setPriority':
      return { restorePath: path, send: (client, auth) => client.put(`${path}/.priority`, data ?? null, { auth }) };
    default:
      return `the staging engine does not check '${event.method}' operations.`;
  }
}

/** Perform a captured commit; the reason it cannot be performed when its method is not one replay handles. */
async function writeCommit(
  client: RtdbRestClient,
  commit: SandboxCommitEvent,
  auth: RtdbAuthOverride | undefined,
  lease: unknown,
): Promise<RtdbRestResponse | string> {
  const path = commit.path ?? '/';
  const atRoot = path === '/';
  const request = auth === undefined ? {} : { auth };
  const detail = commit.detail ?? {};
  switch (commit.method) {
    case 'update':
      return client.patch(path, commit.data, request);
    case 'remove':
      // Removing the root as admin keeps the lease; a user's removal is decided as a write of nothing.
      return atRoot ? client.put(path, withLease(null, lease), request) : client.delete(path, request);
    case 'setPriority':
      return client.put(`${path}/.priority`, commit.data ?? null, request);
    case 'transaction':
      return client.put(path, atRoot ? withLease(commit.data ?? null, lease) : commit.data ?? null, request);
    case 'set': {
      const value = withPriority(commit.data ?? null, Object.hasOwn(detail, 'priority') ? detail.priority : undefined);
      return client.put(path, atRoot ? withLease(value, lease) : value, request);
    }
    default:
      return `the staging engine does not replay '${commit.method}' commits.`;
  }
}

/** A value with a `.priority`, in the shape the REST API reads it; the value itself when there is none. */
function withPriority(value: unknown, priority: unknown): unknown {
  if (priority === undefined || priority === null) return value;
  if (isObject(value)) return { ...value, '.priority': priority };
  return { '.value': value, '.priority': priority };
}

/** The REST query parameters for a captured query, or the reason REST cannot express it. */
function restQuery(event: SandboxOperationEvent): Record<string, string> | string | undefined {
  const spec = event.request?.query as
    | { orderBy: { kind: string; path?: string } | null; bounds: Array<{ kind: string; value: unknown; key?: string }>; limit: { kind: string; n: number } | null }
    | undefined;
  if (spec === undefined) return undefined;
  const query: Record<string, string> = {};
  const order = spec.orderBy;
  if (order === null) {
    if (spec.bounds.length > 0 || spec.limit !== null) query.orderBy = JSON.stringify('$priority');
  } else if (order.kind === 'child') {
    query.orderBy = JSON.stringify(order.path);
  } else {
    query.orderBy = JSON.stringify(`$${order.kind}`);
  }
  for (const bound of spec.bounds) {
    if (bound.key !== undefined) return `the REST API cannot express a ${bound.kind} bound with a key.`;
    if (bound.kind !== 'startAt' && bound.kind !== 'endAt' && bound.kind !== 'equalTo') {
      return `the REST API has no ${bound.kind} parameter.`;
    }
    query[bound.kind] = JSON.stringify(bound.value);
  }
  if (spec.limit !== null) query[spec.limit.kind] = String(spec.limit.n);
  return query;
}

function authOverride(event: SandboxCommitEvent | SandboxOperationEvent): RtdbAuthOverride {
  if (event.auth === null) return null;
  return rtdbAuthVariable(event.auth, typeof event.at === 'number' ? event.at : Date.now()) as unknown as Record<string, unknown>;
}

function pathOf(event: { path?: string }): string {
  return event.path ?? '/';
}

function denied(event: { path?: string; method: string }, res: RtdbRestResponse): RtdbReplayDivergence {
  return { kind: 'now-denied', path: pathOf(event), method: event.method, reason: `production denied it under the candidate rules (HTTP ${res.status}).` };
}

function unsupported(event: { path?: string; method: string }, res: RtdbRestResponse): RtdbReplayDivergence {
  return { kind: 'unsupported', path: pathOf(event), method: event.method, reason: `production answered HTTP ${res.status}: ${productionMessage(res)}` };
}

function productionMessage(res: RtdbRestResponse): string {
  const error = isObject(res.body) ? res.body.error : undefined;
  return (typeof error === 'string' ? error : res.text).slice(0, 500);
}

async function expectOk(pending: Promise<RtdbRestResponse>, what: string): Promise<RtdbRestResponse> {
  const res = await pending;
  if (res.status !== 200) throw new Error(`staging engine: ${what} failed: HTTP ${res.status} ${productionMessage(res)}`);
  return res;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
