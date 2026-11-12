/**
 * Orchestrates assurance probe planning and sandbox execution for an app's
 * extracted access sites, rule owner bindings, and optional seed state.
 */
import type { AccessSite } from '../code/types.js';
import { isWriteOp } from '../code/operation-specs.js';
import {
  firestoreRequiredClaims,
  rtdbRequiredClaims,
  storageRequiredClaims,
} from '../rules/claims.js';
import { projectRuleSurface } from '../rules/rule-surface.js';
import type { RuleSources, StorageRuleSource } from '../rules/rule-sources.js';
import { storageValueHints } from '../rules/storage-owners.js';
import type { OwnerBinding, OwnerCondition } from '../rules/types.js';
import { firestoreValueHints, rtdbValueHints } from '../rules/value-hints.js';
import { planProbes } from './plan.js';
import { findingFor, runProbe, type ProbeRules } from './run.js';
import { namesFromState, rtdbReadOnlySitesFromState, sitesFromState } from './state.js';
import type { Finding, Probe, ProbeActor, ProbeResult, ProbeStep } from './types.js';
import type { WorldState } from './world.js';
import { normalizeStorageBucketKey, type WorldStorageRules } from './world-storage.js';

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
  photoUrl?: string;
  phoneNumber?: string;
  tenantId?: string;
  providerId?: string;
  providerUserInfo?: readonly { providerId: string }[];
  customClaims?: Record<string, unknown>;
  emailVerified?: boolean;
  disabled?: boolean;
}

function setOwnTokenField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function copyOwnTokenFields(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
  overwrite = true,
): void {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (!overwrite && Object.hasOwn(target, key)) continue;
    setOwnTokenField(target, key, Object.getOwnPropertyDescriptor(source, key)?.value);
  }
}

function selectTwoUsers(users: ProbeUser[]): {
  first: { user: ProbeUser; synthetic: boolean };
  second: { user: ProbeUser; synthetic: boolean };
} {
  const enabled = users.filter((u) => u.disabled !== true);
  if (enabled.length >= 2) {
    return {
      first: { user: enabled[0]!, synthetic: false },
      second: { user: enabled[1]!, synthetic: false },
    };
  }
  const takenUids = new Set(users.map((u) => u.uid));
  const allocateSyntheticUid = (base: string): string => {
    if (!takenUids.has(base)) {
      takenUids.add(base);
      return base;
    }
    let suffix = 2;
    while (takenUids.has(`${base}-${suffix}`)) {
      suffix += 1;
    }
    const candidate = `${base}-${suffix}`;
    takenUids.add(candidate);
    return candidate;
  };
  if (enabled.length === 1) {
    return {
      first: { user: enabled[0]!, synthetic: false },
      second: {
        user: { uid: allocateSyntheticUid('probe-peer'), displayName: 'Probe Peer' },
        synthetic: true,
      },
    };
  }
  return {
    first: {
      user: { uid: allocateSyntheticUid('probe-owner'), displayName: 'Probe Owner' },
      synthetic: true,
    },
    second: {
      user: { uid: allocateSyntheticUid('probe-peer'), displayName: 'Probe Peer' },
      synthetic: true,
    },
  };
}

/**
 * Two signed-in actors carrying required token claims. With known users from a
 * seed, the first two enabled accounts are chosen with the names their records
 * already show; otherwise two synthetic probe identities are used.
 */
export function probeActors(
  claims: Record<string, unknown>,
  users: ProbeUser[] = [],
  names: Map<string, string> = new Map(),
): { owner: ProbeActor; peer: ProbeActor } {
  const make = (
    role: 'owner' | 'peer',
    user: ProbeUser,
    synthetic: boolean,
  ): ProbeActor => {
    const email = user.email ?? `${user.uid}@example.test`;
    const displayName = user.displayName ?? names.get(user.uid) ?? user.uid;
    const emailVerified = user.emailVerified ?? true;
    const token: Record<string, unknown> = {};
    copyOwnTokenFields(token, claims);
    setOwnTokenField(token, 'email_verified', emailVerified);
    if (synthetic && typeof claims.email_verified === 'boolean' && user.emailVerified === undefined) {
      setOwnTokenField(token, 'email_verified', claims.email_verified);
    }
    if (user.customClaims) copyOwnTokenFields(token, user.customClaims);
    const actor: ProbeActor = { role, uid: user.uid, email, displayName, token, synthetic };
    if (user.disabled === true) actor.disabled = true;
    return actor;
  };

  const chosen = selectTwoUsers(users);
  return {
    owner: make('owner', chosen.first.user, chosen.first.synthetic),
    peer: make('peer', chosen.second.user, chosen.second.synthetic),
  };
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
  /** Resolved default Cloud Storage bucket ID (e.g. `<projectId>.firebasestorage.app`). */
  defaultBucket?: string;
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
  if (step.method === 'list') return 'list';
  if (step.method === 'update') return 'update';
  if (step.service === 'firestore' && existingFirestoreDocs.has(step.path)) return 'update';
  return 'create';
}

function collectStepClaims(
  step: ProbeStep,
  stepOp: string,
  sources: RuleSources,
  into: Record<string, unknown>,
  defaultBucket?: string,
): void {
  if (step.service === 'firestore') {
    for (const source of sources.firestore) {
      firestoreRequiredClaims(source.text, { path: step.path, op: stepOp }, into);
    }
    return;
  }
  if (step.service === 'storage') {
    for (const source of sources.storage ?? []) {
      const normalizedStepBucket = normalizeStorageBucketKey(step.resourceId);
      if (
        source.bucket !== undefined
        && normalizedStepBucket !== undefined
        && source.bucket !== normalizedStepBucket
      ) {
        continue;
      }
      let bucket = step.resourceId;
      if (bucket === undefined) bucket = source.bucket ?? defaultBucket;
      storageRequiredClaims(source.text, { path: step.path, op: stepOp, bucket }, into);
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

function initialFirestoreDocPaths(state: WorldState | undefined): Set<string> {
  if (state?.firestore) return new Set(Object.keys(state.firestore));
  const snapshotDocs = state?.snapshot?.firestore['(default)'];
  if (snapshotDocs) return new Set(Object.keys(snapshotDocs));
  return new Set();
}

function seedUsersFromInput(input: RunProbesInput): ProbeUser[] {
  const snapshotUsers = input.state?.snapshot?.auth.users ?? input.state?.users;
  if (snapshotUsers && snapshotUsers.length > 0) {
    const mappedSnapshotUsers = snapshotUsers.map((user): ProbeUser => {
      const entry: ProbeUser = { uid: user.uid, emailVerified: user.emailVerified === true };
      if (user.email !== undefined) entry.email = user.email;
      if (user.displayName !== undefined) entry.displayName = user.displayName;
      if (user.photoUrl !== undefined) entry.photoUrl = user.photoUrl;
      if (user.phoneNumber !== undefined) entry.phoneNumber = user.phoneNumber;
      if (user.tenantId !== undefined) entry.tenantId = user.tenantId;
      if (user.providerId !== undefined) entry.providerId = user.providerId;
      if (user.providerUserInfo !== undefined) {
        entry.providerUserInfo = user.providerUserInfo.map((p) => ({ ...p }));
      }
      if (user.disabled !== undefined) entry.disabled = user.disabled;
      if (user.customClaims !== undefined) {
        entry.customClaims = { ...user.customClaims };
      }
      return entry;
    });
    if (!input.users || input.users.length === 0 || snapshotUsers.some((u) => u.disabled === true)) {
      return mappedSnapshotUsers;
    }
  }
  if (input.users && input.users.length > 0) return input.users;
  return [];
}

function buildProbeStorageRules(
  storageSources: readonly StorageRuleSource[] | undefined,
  state: WorldState | undefined,
  defaultBucket?: string,
): WorldStorageRules | undefined {
  if (storageSources && storageSources.length > 0) {
    if (
      storageSources.length === 1 &&
      (storageSources[0]!.bucket === undefined ||
        (defaultBucket !== undefined && storageSources[0]!.bucket === defaultBucket))
    ) {
      return storageSources[0]!.text;
    }
    const map: Record<string, string> = {};
    for (const src of storageSources) {
      let key = '(default)';
      if (
        src.bucket !== undefined &&
        src.bucket.length > 0 &&
        !(defaultBucket !== undefined && src.bucket === defaultBucket)
      ) {
        key = src.bucket;
      }
      Object.defineProperty(map, key, {
        value: src.text,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return map;
  }
  const snapshotStorageRules = state?.snapshot?.rules.storage;
  if (snapshotStorageRules && Object.keys(snapshotStorageRules).length > 0) {
    return snapshotStorageRules;
  }
  return undefined;
}

function mergeActorClaims(
  baseActor: ProbeActor,
  extractedClaims: Readonly<Record<string, unknown>>,
  seededUser: ProbeUser | undefined,
): ProbeActor {
  const token: Record<string, unknown> = {};
  copyOwnTokenFields(token, baseActor.token);
  copyOwnTokenFields(token, extractedClaims);
  if (seededUser?.customClaims !== undefined) {
    copyOwnTokenFields(token, seededUser.customClaims);
  }
  if (!baseActor.synthetic && typeof seededUser?.emailVerified === 'boolean') {
    setOwnTokenField(token, 'email_verified', seededUser.emailVerified);
  }
  return { ...baseActor, token };
}

function extractProbeClaims(
  probe: Probe,
  sources: RuleSources,
  state: WorldState | undefined,
  defaultBucket: string | undefined,
): { ownerClaims: Record<string, unknown>; peerClaims: Record<string, unknown> } {
  const existingFirestoreDocs = initialFirestoreDocPaths(state);
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
      collectStepClaims(step, stepOp, sources, ownerClaims, defaultBucket);
    } else if (step.actor === 'peer') {
      collectStepClaims(step, stepOp, sources, peerClaims, defaultBucket);
    }
    if (step.service === 'firestore') {
      if (stepOp === 'delete') existingFirestoreDocs.delete(step.path);
      else if (stepOp !== 'get') existingFirestoreDocs.add(step.path);
    }
  }
  return { ownerClaims, peerClaims };
}

/** Plan and run every probe; findings come only from reproduced hits. */
export async function runProbes(input: RunProbesInput): Promise<ProbeReport> {
  const normalizedDefaultBucket = normalizeStorageBucketKey(
    input.defaultBucket ?? input.state?.defaultBucket,
  );
  let effectiveState: WorldState | undefined = input.state;
  if (normalizedDefaultBucket !== undefined) {
    effectiveState = { ...(effectiveState ?? {}), defaultBucket: normalizedDefaultBucket };
  }
  if (input.users && input.users.length > 0 && effectiveState?.users === undefined) {
    effectiveState = { ...(effectiveState ?? {}), users: input.users };
  }
  const allUsers = byPresence(seedUsersFromInput(input), effectiveState);
  const chosenUsers = selectTwoUsers(allUsers);
  const selectedUsers: ProbeUser[] = [];
  if (!chosenUsers.first.synthetic) selectedUsers.push(chosenUsers.first.user);
  if (!chosenUsers.second.synthetic) selectedUsers.push(chosenUsers.second.user);
  const names = namesFromState(
    input.accessSites,
    effectiveState,
    selectedUsers.map((user) => user.uid),
  );
  const { owner, peer } = probeActors({}, allUsers, names);
  const storageSources = input.sources.storage ?? [];
  const defaultFirestoreSources = input.sources.firestore.filter(
    (source) => source.database === undefined || source.database === '(default)',
  );
  const defaultRtdbSources = input.sources.rtdb.filter(
    (source) => source.instance === undefined || source.instance === '(default)',
  );
  const scopedSources: RuleSources = {
    firestore: defaultFirestoreSources,
    rtdb: defaultRtdbSources,
    storage: storageSources,
    problems: input.sources.problems,
  };
  const rules: ProbeRules = {
    firestore: defaultFirestoreSources[0]?.text,
    rtdb: defaultRtdbSources.map((source) => source.json),
    storage: buildProbeStorageRules(storageSources, effectiveState, normalizedDefaultBucket),
  };
  const hints = [
    ...defaultRtdbSources.flatMap((source) => rtdbValueHints(source.json)),
    ...defaultFirestoreSources.flatMap((source) => firestoreValueHints(source.text)),
    ...storageSources.flatMap((source) => storageValueHints(source.text, source.bucket)),
  ];
  const surface = projectRuleSurface({
    firestore: defaultFirestoreSources,
    rtdb: defaultRtdbSources,
    storage: storageSources,
  });
  const knownUids = allUsers.filter((user) => user.disabled !== true).map((user) => user.uid);

  let sites = input.accessSites.filter(
    (site) =>
      !site.admin
      && (
        site.service === 'storage'
        || site.resourceId === undefined
        || site.resourceId === '(default)'
      ),
  );
  const hasFirestoreClientWrite = sites.some((site) => site.service === 'firestore' && isWriteOp(site.op));
  if (rules.firestore && !hasFirestoreClientWrite) {
    sites = [...sites, ...sitesFromState(effectiveState, knownUids)];
  }
  const hasRtdbState =
    Boolean(effectiveState?.rtdb) ||
    Boolean(effectiveState?.snapshot && Object.hasOwn(effectiveState.snapshot.rtdb, '(default)'));
  if (rules.rtdb.length > 0 && hasRtdbState) {
    sites = [...sites, ...rtdbReadOnlySitesFromState(sites, effectiveState, knownUids)];
  }

  const planInput: {
    sites: typeof sites;
    bindings: typeof input.ownerBindings;
    conditions: typeof input.conditions;
    owner: typeof owner;
    peer: typeof peer;
    hints: typeof hints;
    state?: WorldState;
    surface: typeof surface;
    defaultBucket?: string;
  } = {
    sites,
    bindings: input.ownerBindings,
    conditions: input.conditions,
    owner,
    peer,
    hints,
    state: effectiveState,
    surface,
  };
  if (normalizedDefaultBucket !== undefined) planInput.defaultBucket = normalizedDefaultBucket;
  const probes = planProbes(planInput);

  const seededOwner = chosenUsers.first.synthetic ? undefined : chosenUsers.first.user;
  const seededPeer = chosenUsers.second.synthetic ? undefined : chosenUsers.second.user;
  const storageCrossServiceDenied =
    effectiveState?.snapshot?.storageConfig?.crossServiceIam === 'denied' &&
    (
      storageSources.some((source) => /\bfirestore\s*\.\s*(?:get|exists)\s*\(/.test(source.text)) ||
      Object.values(effectiveState?.snapshot?.rules.storage ?? {}).some((text) =>
        /\bfirestore\s*\.\s*(?:get|exists)\s*\(/.test(text),
      )
    );

  const results: ProbeResult[] = [];
  const claimsByProbe = new Map<
    Probe,
    { ownerClaims: Record<string, unknown>; peerClaims: Record<string, unknown> }
  >();
  for (const probe of probes) {
    const extracted = extractProbeClaims(probe, scopedSources, effectiveState, normalizedDefaultBucket);
    let effectiveProbe = probe;
    if (
      probe.kind === 'must-allow-denied' &&
      probe.inconclusiveOnDeny === undefined &&
      !owner.synthetic &&
      seededOwner?.emailVerified === false &&
      extracted.ownerClaims.email_verified === true
    ) {
      effectiveProbe = {
        ...probe,
        inconclusiveOnDeny: 'seeded owner account has emailVerified: false while rule requires verified email',
      };
    } else if (
      probe.kind === 'must-allow-denied' &&
      probe.service === 'storage' &&
      probe.inconclusiveOnDeny === undefined &&
      storageCrossServiceDenied
    ) {
      effectiveProbe = {
        ...probe,
        inconclusiveOnDeny: "sandbox Storage crossServiceIam is configured as 'denied'",
      };
    }
    claimsByProbe.set(effectiveProbe, extracted);
    const scopedActors: [ProbeActor, ProbeActor] = [
      mergeActorClaims(owner, extracted.ownerClaims, seededOwner),
      mergeActorClaims(peer, extracted.peerClaims, seededPeer),
    ];
    const result = await runProbe(effectiveProbe, rules, scopedActors, effectiveState ?? {});
    if (result) results.push({ ...result, actors: scopedActors });
  }

  const hitResults = results.filter((result) => result.outcome === 'hit');
  const claimSourceResults =
    hitResults.length > 0
      ? hitResults
      : results.filter((result) => result.outcome === 'clean');
  const reportOwnerClaims: Record<string, unknown> = {};
  const reportPeerClaims: Record<string, unknown> = {};
  for (const result of claimSourceResults) {
    const extracted = claimsByProbe.get(result.probe);
    if (!extracted) continue;
    copyOwnTokenFields(reportOwnerClaims, extracted.ownerClaims, false);
    copyOwnTokenFields(reportPeerClaims, extracted.peerClaims, false);
  }
  const actors: ProbeActor[] = [
    mergeActorClaims(owner, reportOwnerClaims, seededOwner),
    mergeActorClaims(peer, reportPeerClaims, seededPeer),
  ];

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.outcome !== 'hit') continue;
    const finding = findingFor(result, result.actors ? [...result.actors] : actors);
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
