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
 * hold no data; its rules are restored and its data deleted on every exit,
 * then both are read back, and a run that cannot prove that fails loudly.
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

/**
 * Run `fn` against the staging instance behind `client`, guarded: refuse an
 * instance without the marker for `projectId` or with data, and on every exit
 * restore its rules, delete its data, and read both back.
 */
export async function withStagingInstance<T>(
  client: RtdbRestClient,
  projectId: string,
  fn: () => Promise<T>,
): Promise<{ result: T; invariants: StagingInvariants }> {
  const priorRules = await client.getRulesText();
  const marked = markedProject(priorRules);
  if (marked === undefined) {
    throw new StagingSafetyError(
      `${client.databaseUrl} is not enrolled for staging verification, or a verification is running on it now (its rules do not start with the enrollment marker). Run \`pyric verify staging init\` once to enroll a dedicated, empty instance.`,
    );
  }
  if (marked !== projectId) {
    throw new StagingSafetyError(`${client.databaseUrl} is enrolled for project ${marked}, not ${projectId}.`);
  }
  const root = await client.get('/', { shallow: true });
  if (root.status !== 200) throw new StagingSafetyError(`reading ${client.databaseUrl} failed: HTTP ${root.status} ${root.text.slice(0, 200)}`);
  if (root.body !== null) {
    throw new StagingSafetyError(
      `${client.databaseUrl} holds data, so it is not a dedicated staging instance or a verification is running on it now. Refusing to replace it.`,
    );
  }

  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await fn() };
  } catch (error) {
    outcome = { ok: false, error };
  }

  const removed = await client.delete('/');
  const restored = await client.putRules(priorRules);
  const rulesBack = await client.getRulesText().catch(() => undefined);
  const rootBack = await client.get('/', { shallow: true });
  const invariants: StagingInvariants = {
    rulesRestored: restored.status === 200 && rulesBack === priorRules,
    dataRemoved: removed.status === 200 && rootBack.status === 200 && rootBack.body === null,
  };
  if (!invariants.rulesRestored || !invariants.dataRemoved) {
    throw new StagingSafetyError(
      `${client.databaseUrl} was not left as it was found (rules restored: ${invariants.rulesRestored}, data removed: ${invariants.dataRemoved}). Inspect it before running again.`,
    );
  }
  if (!outcome.ok) throw outcome.error;
  return { result: outcome.value, invariants };
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
}): Promise<StagingInstanceRun> {
  const { client, events } = input;
  const label = input.instance === undefined ? 'the default instance' : `instance "${input.instance}"`;
  const source = JSON.stringify(input.rules, null, 2);
  const dry = await client.putRules(source, { dryRun: true });
  if (dry.status !== 200) throw new StagingDeployRefusedError(label, productionMessage(dry));
  const deployed = await client.putRules(source);
  if (deployed.status !== 200) throw new StagingDeployRefusedError(label, productionMessage(deployed));

  if (input.capturedState !== undefined) {
    const initial = await rewoundRtdbTree(events, input.capturedState, input.instance);
    if (initial !== null) await expectOk(client.put('/', initial), 'seeding the session\'s starting tree');
  }

  const divergences: RtdbReplayDivergence[] = [];
  let checkedEvents = 0;
  for (const step of rtdbReplaySteps(events, input.instance)) {
    if (step.kind === 'admin-commit') {
      await expectOk(writeCommit(client, step.event, undefined), `the admin ${step.event.method} at ${step.event.path}`);
      continue;
    }
    checkedEvents += 1;
    if (step.kind === 'app-commit') {
      const res = await writeCommit(client, step.event, authOverride(step.event));
      if (isRestDenial(res.status)) divergences.push(denied(step.event, res));
      else if (res.status !== 200) divergences.push(unsupported(step.event, res));
    } else if (step.kind === 'allowed-read') {
      const query = restQuery(step.event);
      if (typeof query === 'string') {
        divergences.push({ kind: 'unsupported', path: pathOf(step.event), method: step.event.method, reason: query });
        continue;
      }
      const res = await client.get(pathOf(step.event), { auth: authOverride(step.event), query });
      if (isRestDenial(res.status)) divergences.push(denied(step.event, res));
      else if (res.status !== 200) divergences.push(unsupported(step.event, res));
    } else {
      await decide(client, step.event, step.kind === 'denial' ? 'deny' : 'allow', divergences);
    }
  }

  if (input.capturedState !== undefined) {
    const finalTree = await expectOk(client.get('/'), 'reading the replayed tree');
    divergences.push(...rtdbStateDrift(input.capturedState, finalTree.body));
  }
  return { checkedEvents, divergences };
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
      await expectOk(client.put(write.restorePath, before.body), `putting ${write.restorePath} back after the attempt`);
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
      return { restorePath: path, send: (client, auth) => client.put(path, data ?? null, { auth }) };
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

function writeCommit(client: RtdbRestClient, commit: SandboxCommitEvent, auth: RtdbAuthOverride | undefined): Promise<RtdbRestResponse> {
  const path = commit.path ?? '/';
  const request = auth === undefined ? {} : { auth };
  const detail = commit.detail ?? {};
  switch (commit.method) {
    case 'update':
      return client.patch(path, commit.data, request);
    case 'remove':
      return client.delete(path, request);
    case 'setPriority':
      return client.put(`${path}/.priority`, commit.data ?? null, request);
    case 'transaction':
      return client.put(path, commit.data ?? null, request);
    default:
      return client.put(path, withPriority(commit.data ?? null, Object.hasOwn(detail, 'priority') ? detail.priority : undefined), request);
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
