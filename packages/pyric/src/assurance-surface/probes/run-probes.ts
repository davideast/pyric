/**
 * Orchestrates assurance probe planning and sandbox execution for an app's
 * extracted access sites, rule owner bindings, and optional seed state.
 */
import type { AccessSite } from '../code/types.js';
import { isWriteOp } from '../code/operation-specs.js';
import { projectRuleSurface } from '../rules/rule-surface.js';
import type { RuleSources, StorageRuleSource } from '../rules/rule-sources.js';
import { storageValueHints } from '../rules/storage-owners.js';
import type { OwnerBinding, OwnerCondition } from '../rules/types.js';
import { firestoreValueHints, rtdbValueHints } from '../rules/value-hints.js';
import { planProbes } from './plan.js';
import {
  buildCounterfactualClaimActor,
  classifySeededOwnerClaimMismatch,
  copyOwnTokenFields,
  extractProbeClaims,
  mergeActorClaims,
  probeActors,
  selectTwoUsers,
  type ProbeUser,
} from './probe-actor-claims.js';
import { findingFor, runProbe, type ProbeRules } from './run.js';
import { namesFromState, rtdbReadOnlySitesFromState, sitesFromState } from './state.js';
import type { Finding, Probe, ProbeActor, ProbeResult } from './types.js';
import type { WorldState } from './world.js';
import { normalizeStorageBucketKey, type WorldStorageRules } from './world-storage.js';

export { probeActors, type ProbeUser };

export interface ProbeReport {
  probes: { total: number; invalid: number };
  findings: Finding[];
  results: ProbeResult[];
  actors: ProbeActor[];
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
    if (
      !input.users
      || input.users.length === 0
      || snapshotUsers.some((u) => u.disabled === true)
    ) {
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
      storageSources.length === 1
      && (storageSources[0]!.bucket === undefined
        || (defaultBucket !== undefined && storageSources[0]!.bucket === defaultBucket))
    ) {
      return storageSources[0]!.text;
    }
    const map: Record<string, string> = {};
    for (const src of storageSources) {
      let key = '(default)';
      if (
        src.bucket !== undefined
        && src.bucket.length > 0
        && !(defaultBucket !== undefined && src.bucket === defaultBucket)
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
      && (site.service === 'storage'
        || site.resourceId === undefined
        || site.resourceId === '(default)'),
  );
  const hasFirestoreClientWrite = sites.some(
    (site) => site.service === 'firestore' && isWriteOp(site.op),
  );
  if (rules.firestore && !hasFirestoreClientWrite) {
    sites = [...sites, ...sitesFromState(effectiveState, knownUids)];
  }
  const hasRtdbState =
    Boolean(effectiveState?.rtdb)
    || Boolean(effectiveState?.snapshot && Object.hasOwn(effectiveState.snapshot.rtdb, '(default)'));
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

  let seededOwner: ProbeUser | undefined;
  if (!chosenUsers.first.synthetic) seededOwner = chosenUsers.first.user;
  let seededPeer: ProbeUser | undefined;
  if (!chosenUsers.second.synthetic) seededPeer = chosenUsers.second.user;

  const storageCrossServiceDenied =
    effectiveState?.snapshot?.storageConfig?.crossServiceIam === 'denied'
    && (storageSources.some((source) => /\bfirestore\s*\.\s*(?:get|exists)\s*\(/.test(source.text))
      || Object.values(effectiveState?.snapshot?.rules.storage ?? {}).some((text) =>
        /\bfirestore\s*\.\s*(?:get|exists)\s*\(/.test(text),
      ));

  const results: ProbeResult[] = [];
  const claimsByProbe = new Map<
    Probe,
    { ownerClaims: Record<string, unknown>; peerClaims: Record<string, unknown> }
  >();
  for (const probe of probes) {
    const extracted = extractProbeClaims(probe, scopedSources, effectiveState, normalizedDefaultBucket);
    let effectiveProbe = probe;
    let claimMismatchReason: string | undefined;
    if (
      probe.kind === 'must-allow-denied'
      && probe.inconclusiveOnDeny === undefined
      && !owner.synthetic
    ) {
      claimMismatchReason = classifySeededOwnerClaimMismatch(seededOwner, extracted.ownerClaims);
    }
    if (
      claimMismatchReason === undefined
      && probe.kind === 'must-allow-denied'
      && probe.service === 'storage'
      && probe.inconclusiveOnDeny === undefined
      && storageCrossServiceDenied
    ) {
      effectiveProbe = {
        ...probe,
        inconclusiveOnDeny: "sandbox Storage crossServiceIam is configured as 'denied'",
      };
    }

    const scopedActors: [ProbeActor, ProbeActor] = [
      mergeActorClaims(owner, extracted.ownerClaims, seededOwner),
      mergeActorClaims(peer, extracted.peerClaims, seededPeer),
    ];
    let result = await runProbe(effectiveProbe, rules, scopedActors, effectiveState ?? {});
    if (result && result.outcome === 'hit' && claimMismatchReason !== undefined) {
      const counterfactualOwner = buildCounterfactualClaimActor(
        owner,
        extracted.ownerClaims,
        seededOwner,
      );
      const counterfactualResult = await runProbe(
        effectiveProbe,
        rules,
        [counterfactualOwner, scopedActors[1]],
        effectiveState ?? {},
      );
      if (counterfactualResult?.outcome !== 'hit') {
        const abstainedProbe: Probe = {
          ...effectiveProbe,
          inconclusiveOnDeny: claimMismatchReason,
        };
        effectiveProbe = abstainedProbe;
        result = {
          ...result,
          probe: abstainedProbe,
          outcome: 'invalid',
          reason: claimMismatchReason,
          abstained: true,
        };
      }
    }
    claimsByProbe.set(effectiveProbe, extracted);
    if (result) results.push({ ...result, actors: scopedActors });
  }

  const hitResults = results.filter((result) => result.outcome === 'hit');
  let claimSourceResults = results.filter((result) => result.outcome === 'clean');
  if (hitResults.length > 0) claimSourceResults = hitResults;
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
    let findingActors = actors;
    if (result.actors) findingActors = [...result.actors];
    const finding = findingFor(result, findingActors);
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
