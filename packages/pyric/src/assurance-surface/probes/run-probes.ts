/**
 * Orchestrates assurance probe planning and sandbox execution for an app's
 * extracted access sites, rule owner bindings, and optional seed state.
 */
import type { AccessSite } from '../code/types.js';
import { isWriteOp } from '../code/operation-specs.js';
import { firestoreRequiredClaims, rtdbRequiredClaims } from '../rules/claims.js';
import type { RuleSources } from '../rules/rule-sources.js';
import type { OwnerBinding, OwnerCondition } from '../rules/types.js';
import { firestoreValueHints, rtdbValueHints } from '../rules/value-hints.js';
import { planProbes } from './plan.js';
import { findingFor, runProbe, type ProbeRules } from './run.js';
import { namesFromState, rtdbReadOnlySitesFromState, sitesFromState } from './state.js';
import type { Finding, Probe, ProbeActor, ProbeResult, ProbeStep } from './types.js';
import type { WorldState } from './world.js';

export interface ProbeReport {
  probes: { total: number; invalid: number };
  findings: Finding[];
  results: ProbeResult[];
  actors: ProbeActor[];
}

/** A known user (from a seed) a probe may act as. */
export interface ProbeUser {
  uid: string;
  email?: string;
  displayName?: string;
  customClaims?: Record<string, unknown>;
  emailVerified?: boolean;
}

/**
 * Two signed-in actors carrying required token claims. With known users from a
 * seed, the first two are chosen with the names their records already show;
 * otherwise two synthetic probe identities are used.
 */
export function probeActors(
  claims: Record<string, unknown>,
  users: ProbeUser[] = [],
  names: Map<string, string> = new Map(),
): { owner: ProbeActor; peer: ProbeActor } {
  const make = (role: 'owner' | 'peer', user: ProbeUser): ProbeActor => {
    const email = user.email ?? `${user.uid}@example.test`;
    const displayName = user.displayName ?? names.get(user.uid) ?? user.uid;
    const emailVerified = user.emailVerified ?? true;
    const token: Record<string, unknown> = { email_verified: emailVerified, ...claims };
    if (user.customClaims) Object.assign(token, user.customClaims);
    return { role, uid: user.uid, email, displayName, token };
  };

  let firstUser: ProbeUser = { uid: 'probe-owner', displayName: 'Probe Owner' };
  let secondUser: ProbeUser = { uid: 'probe-peer', displayName: 'Probe Peer' };
  if (users.length >= 2) {
    firstUser = users[0];
    secondUser = users[1];
  }
  return { owner: make('owner', firstUser), peer: make('peer', secondUser) };
}

export interface RunProbesInput {
  accessSites: AccessSite[];
  ownerBindings: OwnerBinding[];
  conditions: OwnerCondition[];
  sources: RuleSources;
  /** Existing data to start every probe from (a seed). */
  state?: WorldState;
  /** Known users in that seed; probes act as two of them. */
  users?: ProbeUser[];
}

/** Known users ordered by how much of the seed they own (their uid appearing as a value or key), most first. */
function byPresence(users: ProbeUser[], state: WorldState | undefined): ProbeUser[] {
  if (!state) return users;
  const text = JSON.stringify(state);
  const count = (uid: string): number => text.split(`"${uid}"`).length - 1;
  return [...users].sort((x, y) => count(y.uid) - count(x.uid));
}

function classifyStepOp(step: ProbeStep, existingFirestoreDocs: ReadonlySet<string>): string {
  if (step.method === 'delete' || step.method === 'remove') return 'delete';
  if (step.method === 'get') return 'get';
  if (step.method === 'update') return 'update';
  if (step.service === 'firestore' && existingFirestoreDocs.has(step.path)) return 'update';
  return 'create';
}

function collectStepClaims(
  step: ProbeStep,
  stepOp: string,
  sources: RuleSources,
  into: Record<string, unknown>,
): void {
  if (step.service === 'firestore') {
    for (const source of sources.firestore) {
      firestoreRequiredClaims(source.text, { path: step.path, op: stepOp }, into);
    }
    return;
  }
  if (step.path === '' && step.method === 'update' && step.data && typeof step.data === 'object' && !Array.isArray(step.data)) {
    for (const subPath of Object.keys(step.data)) {
      for (const source of sources.rtdb) {
        rtdbRequiredClaims(source.json, { path: subPath, op: 'update' }, into);
      }
    }
    return;
  }
  for (const source of sources.rtdb) {
    rtdbRequiredClaims(source.json, { path: step.path, op: stepOp }, into);
  }
}

function actorsForProbe(
  probe: Probe,
  baseOwner: ProbeActor,
  basePeer: ProbeActor,
  users: ProbeUser[],
  sources: RuleSources,
  state: WorldState | undefined,
): ProbeActor[] {
  const existingFirestoreDocs = new Set(Object.keys(state?.firestore ?? {}));
  for (const seedStep of probe.seed) {
    if (seedStep.service !== 'firestore') continue;
    if (seedStep.method === 'delete' || seedStep.method === 'remove') {
      existingFirestoreDocs.delete(seedStep.path);
    } else {
      existingFirestoreDocs.add(seedStep.path);
    }
  }

  const ownerClaims: Record<string, unknown> = {};
  const peerClaims: Record<string, unknown> = {};
  for (const step of [...probe.setup, probe.attack]) {
    const stepOp = classifyStepOp(step, existingFirestoreDocs);
    if (step.actor === 'owner') {
      collectStepClaims(step, stepOp, sources, ownerClaims);
    } else if (step.actor === 'peer') {
      collectStepClaims(step, stepOp, sources, peerClaims);
    }
    if (step.service === 'firestore') {
      if (stepOp === 'delete') existingFirestoreDocs.delete(step.path);
      else if (stepOp !== 'get') existingFirestoreDocs.add(step.path);
    }
  }

  const ownerCustom = users[0]?.customClaims ?? {};
  const peerCustom = users[1]?.customClaims ?? {};
  return [
    { ...baseOwner, token: { ...baseOwner.token, ...ownerClaims, ...ownerCustom } },
    { ...basePeer, token: { ...basePeer.token, ...peerClaims, ...peerCustom } },
  ];
}

/** Plan and run every probe; findings come only from reproduced hits. */
export async function runProbes(input: RunProbesInput): Promise<ProbeReport> {
  const allUsers = byPresence(input.users ?? [], input.state);
  let selectedUsers = allUsers;
  if (allUsers.length >= 2) {
    selectedUsers = [allUsers[0], allUsers[1]];
  }
  const names = namesFromState(
    input.accessSites,
    input.state,
    selectedUsers.map((user) => user.uid),
  );
  const { owner, peer } = probeActors({}, selectedUsers, names);
  const actors = [owner, peer];
  const rules: ProbeRules = {
    firestore: input.sources.firestore[0]?.text,
    rtdb: input.sources.rtdb.map((source) => source.json),
  };
  const hints = [
    ...input.sources.rtdb.flatMap((source) => rtdbValueHints(source.json)),
    ...input.sources.firestore.flatMap((source) => firestoreValueHints(source.text)),
  ];
  const knownUids = allUsers.map((user) => user.uid);

  let sites = input.accessSites;
  const hasFirestoreClientWrite = sites.some((site) => site.service === 'firestore' && isWriteOp(site.op));
  if (rules.firestore && !hasFirestoreClientWrite) {
    sites = [...sites, ...sitesFromState(input.state, knownUids)];
  }
  if (rules.rtdb.length > 0 && input.state?.rtdb) {
    sites = [...sites, ...rtdbReadOnlySitesFromState(sites, input.state, knownUids)];
  }

  const probes = planProbes({
    sites,
    bindings: input.ownerBindings,
    conditions: input.conditions,
    owner,
    peer,
    hints,
    state: input.state,
  });

  const results: ProbeResult[] = [];
  for (const probe of probes) {
    const scopedActors = actorsForProbe(probe, owner, peer, selectedUsers, input.sources, input.state);
    const result = await runProbe(probe, rules, scopedActors, input.state ?? {});
    if (result) results.push(result);
  }

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.outcome !== 'hit') continue;
    const finding = findingFor(result, actors);
    const key = `${finding.path}|${finding.op}|${finding.kind}|${finding.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(finding);
  }

  return {
    probes: {
      total: results.length,
      invalid: results.filter((result) => result.outcome === 'invalid').length,
    },
    findings,
    results,
    actors,
  };
}
