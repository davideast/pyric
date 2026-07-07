import {
  initializeSandbox,
  replay,
  type Divergence,
  type EventService,
  type SandboxCommitEvent,
  type SandboxEvent,
} from 'pyric/sandbox';
import {
  getAdminDatabase,
  getDatabase,
  ref,
  remove,
  runTransaction,
  set,
  update,
  sandbox as rtdbSandbox,
} from 'pyric/database/modular';
import type { RtdbRulesDocument } from 'pyric/rules/rtdb';
import {
  fixtureVerifiableServices,
  parseVerifyFixture,
  VERIFY_FIXTURE_SCHEMA,
  type PyricVerifyFixture,
} from './fixture.js';

export {
  buildVerifyFixture,
  fixtureVerifiableServices,
  parseVerifyFixture,
  VERIFY_FIXTURE_SCHEMA,
  type BuildVerifyFixtureInput,
  type PyricVerifyFixture,
  type VerifyFirestoreRulesBlock,
  type VerifyRtdbRulesBlock,
} from './fixture.js';

export type VerifiableService = 'firestore' | 'rtdb';

export type VerifyRulesInput = {
  firestore?: string | { source: string };
  rtdb?: { rules: Record<string, unknown> } | RtdbRulesDocument;
  storage?: string | { source: string };
};

export interface VerifyFixtureOptions {
  rules: VerifyRulesInput;
  services?: VerifiableService[];
}

export interface VerifyResult {
  ok: boolean;
  services: Partial<Record<VerifiableService, VerifyServiceResult>>;
}

export interface VerifyServiceResult {
  service: VerifiableService;
  ok: boolean;
  checkedEvents: number;
  divergences: VerifyDivergence[];
}

export type VerifyDivergence =
  | {
      service: EventService | string;
      kind: 'now-denied';
      path?: string;
      method?: string;
      reason?: string;
    }
  | {
      service: EventService | string;
      kind: 'state-drift';
      path?: string;
      field?: string;
      before: unknown;
      after: unknown;
    }
  | {
      service: EventService | string;
      kind: 'unsupported';
      path?: string;
      method?: string;
      reason: string;
    }
  | {
      service: EventService | string;
      kind: 'expected-drift';
      drift: string;
      path?: string;
      field?: string;
      before?: unknown;
      after?: unknown;
    };

export class VerifyInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerifyInputError';
  }
}

export async function verifyFixture(
  fixtureInput: PyricVerifyFixture | unknown,
  opts: VerifyFixtureOptions,
): Promise<VerifyResult> {
  const fixture = parseVerifyFixture(fixtureInput);
  const selected = opts.services ?? fixtureVerifiableServices(fixture);
  if (selected.length === 0) {
    throw new VerifyInputError(
      `fixture ${fixture.schema} does not contain a verifiable rules service.`,
    );
  }

  const services: Partial<Record<VerifiableService, VerifyServiceResult>> = {};
  for (const service of selected) {
    if (service === 'firestore') {
      services.firestore = verifyFirestore(fixture, requireFirestoreRules(opts.rules));
    } else if (service === 'rtdb') {
      services.rtdb = await verifyRtdb(fixture, requireRtdbRules(opts.rules));
    } else {
      const exhaustive: never = service;
      throw new VerifyInputError(`unsupported verify service: ${exhaustive}`);
    }
  }
  return {
    ok: Object.values(services).every((result) => result?.ok !== false),
    services,
  };
}

function verifyFirestore(
  fixture: PyricVerifyFixture,
  rules: string,
): VerifyServiceResult {
  const firestore = fixture.services.firestore;
  if (!firestore) {
    throw new VerifyInputError('fixture does not contain services.firestore.');
  }

  const { divergences } = replay(
    fixture.events,
    rules,
    {},
    firestore.state.documents,
  );
  const mapped = divergences.map(mapFirestoreDivergence);
  return {
    service: 'firestore',
    ok: mapped.every(isInformational),
    checkedEvents: fixture.events.filter((event) => event.kind === 'write').length,
    divergences: mapped,
  };
}

async function verifyRtdb(
  fixture: PyricVerifyFixture,
  rulesJson: { rules: Record<string, unknown> },
): Promise<VerifyServiceResult> {
  const rtdb = fixture.services.rtdb;
  if (!rtdb) {
    throw new VerifyInputError('fixture does not contain services.rtdb.');
  }

  const sandbox = initializeSandbox();
  const db = getDatabase(sandbox);
  const adminDb = getAdminDatabase(sandbox);
  rtdbSandbox.setRules(db, rulesJson);
  rtdbSandbox.setData(adminDb, { '/': rtdb.state.tree });

  const divergences: VerifyDivergence[] = [];
  const commits = fixture.events.filter(isRtdbCommit);
  let checkedEvents = 0;
  await rewindRtdbCommits(adminDb, commits);

  for (const commit of commits) {
    const path = commit.path ?? '/';
    if (commit.detail?.admin === true) {
      await replayRtdbAdminCommit(sandbox, commit, divergences);
      continue;
    }

    checkedEvents += 1;
    try {
      await replayRtdbAppCommit(sandbox, commit, divergences);
    } catch (e) {
      divergences.push({
        service: 'rtdb',
        kind: 'now-denied',
        path,
        method: commit.method,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const replayedState = rtdbSandbox.snapshotState(adminDb);
  collectStateDrift('rtdb', rtdb.state.tree, replayedState, '/', divergences);

  return {
    service: 'rtdb',
    ok: divergences.every(isInformational),
    checkedEvents,
    divergences,
  };
}

function requireFirestoreRules(input: VerifyRulesInput): string {
  const rules = input.firestore;
  if (typeof rules === 'string') return rules;
  if (rules && typeof rules.source === 'string') return rules.source;
  throw new VerifyInputError('missing candidate Firestore rules. Pass rules.firestore.');
}

function requireRtdbRules(input: VerifyRulesInput): { rules: Record<string, unknown> } {
  const rules = input.rtdb;
  if (isRtdbRulesDocument(rules)) return rules.toJSON();
  if (isRtdbRulesJson(rules)) return rules;
  throw new VerifyInputError('missing candidate RTDB rules. Pass rules.rtdb.');
}

function isRtdbRulesDocument(value: unknown): value is RtdbRulesDocument {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toJSON' in value &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  );
}

function isRtdbRulesJson(value: unknown): value is { rules: Record<string, unknown> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'rules' in value &&
    isRecord((value as { rules?: unknown }).rules)
  );
}

function mapFirestoreDivergence(divergence: Divergence): VerifyDivergence {
  switch (divergence.kind) {
    case 'real-divergence':
      return {
        service: 'firestore',
        kind: 'state-drift',
        path: divergence.path,
        field: divergence.field,
        before: divergence.before,
        after: divergence.after,
      };
    case 'autoid-alias':
      return {
        service: 'firestore',
        kind: 'expected-drift',
        drift: 'autoid-alias',
        path: divergence.originalPath,
        before: divergence.originalPath,
        after: divergence.replayedPath,
      };
    case 'sentinel-drift':
      return {
        service: 'firestore',
        kind: 'expected-drift',
        drift: 'sentinel-drift',
        path: divergence.path,
        field: divergence.field,
        before: divergence.before,
        after: divergence.after,
      };
    case 'time-drift':
      return {
        service: 'firestore',
        kind: 'expected-drift',
        drift: 'time-drift',
        path: divergence.path,
        field: divergence.field,
        before: divergence.before,
        after: divergence.after,
      };
  }
}

async function replayRtdbAppCommit(
  sandbox: ReturnType<typeof initializeSandbox>,
  commit: SandboxCommitEvent,
  divergences: VerifyDivergence[],
): Promise<void> {
  const db = getDatabase(sandbox.withAuth(commit.auth));
  await replayRtdbCommitWithDatabase(db, commit, divergences);
}

async function replayRtdbAdminCommit(
  sandbox: ReturnType<typeof initializeSandbox>,
  commit: SandboxCommitEvent,
  divergences: VerifyDivergence[],
): Promise<void> {
  const db = getAdminDatabase(sandbox);
  await replayRtdbCommitWithDatabase(db, commit, divergences);
}

async function rewindRtdbCommits(
  adminDb: ReturnType<typeof getAdminDatabase>,
  commits: SandboxCommitEvent[],
): Promise<void> {
  for (const commit of [...commits].reverse()) {
    if (!commit.path) continue;
    await set(ref(adminDb, commit.path), commit.priorState ?? null);
  }
}

async function replayRtdbCommitWithDatabase(
  db: ReturnType<typeof getDatabase>,
  commit: SandboxCommitEvent,
  divergences: VerifyDivergence[],
): Promise<void> {
  const path = commit.path ?? '/';
  const dbRef = ref(db, path);
  switch (commit.method) {
    case 'set':
      await set(dbRef, commit.data);
      break;
    case 'remove':
      await remove(dbRef);
      break;
    case 'update':
      if (!isRecord(commit.data)) {
        divergences.push({
          service: 'rtdb',
          kind: 'unsupported',
          path,
          method: commit.method,
          reason: 'captured RTDB update commit did not contain an object patch.',
        });
        return;
      }
      await update(dbRef, commit.data);
      break;
    case 'transaction':
      await runTransaction(
        dbRef,
        () => commit.data as never,
        { applyLocally: false },
      );
      break;
    default:
      divergences.push({
        service: 'rtdb',
        kind: 'unsupported',
        path,
        method: commit.method,
        reason: `RTDB replay does not support '${commit.method}' commits.`,
      });
  }
}

function isRtdbCommit(event: SandboxEvent): event is SandboxCommitEvent {
  return event.kind === 'commit' && event.service === 'rtdb';
}

function collectStateDrift(
  service: EventService,
  expected: unknown,
  actual: unknown,
  path: string,
  out: VerifyDivergence[],
): void {
  if (deepEqual(expected, actual)) return;
  if (!isRecord(expected) || !isRecord(actual)) {
    out.push({
      service,
      kind: 'state-drift',
      path,
      before: expected,
      after: actual,
    });
    return;
  }

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    collectStateDrift(
      service,
      expected[key],
      actual[key],
      path === '/' ? `/${key}` : `${path}/${key}`,
      out,
    );
  }
}

function isInformational(divergence: VerifyDivergence): boolean {
  return divergence.kind === 'expected-drift';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
