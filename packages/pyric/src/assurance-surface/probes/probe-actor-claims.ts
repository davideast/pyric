/**
 * Probe actor selection, required rule-claim extraction, seeded-user claim
 * isolation, and counterfactual claim-mismatch classification for `runProbes`.
 */
import { isExistenceClaim } from '../rules/claim-algebra.js';
import {
  firestoreRequiredClaims,
  rtdbRequiredClaims,
  storageRequiredClaims,
} from '../rules/claims.js';
import type { RuleSources } from '../rules/rule-sources.js';
import type { Probe, ProbeActor, ProbeStep } from './types.js';
import type { WorldState } from './world.js';
import { normalizeStorageBucketKey } from './world-storage.js';

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

export function copyOwnTokenFields(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
  overwrite = true,
): void {
  for (const key of Object.getOwnPropertyNames(source)) {
    if (!overwrite && Object.hasOwn(target, key)) continue;
    Object.defineProperty(target, key, {
      value: Object.getOwnPropertyDescriptor(source, key)?.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

function setOwnTokenField(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function selectTwoUsers(users: ProbeUser[]): {
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
 * seed, the first two enabled accounts are chosen with the names and verification
 * flags their records actually carry; otherwise two synthetic probe identities are used.
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
    let emailVerified = user.emailVerified === true;
    if (synthetic && user.emailVerified === undefined) {
      emailVerified = true;
    }
    const token: Record<string, unknown> = {};
    if (synthetic) {
      copyOwnTokenFields(token, claims);
    }
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOwnValue(record: Record<string, unknown> | undefined, key: string): unknown {
  if (record === undefined || !Object.hasOwn(record, key)) return undefined;
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function claimValueMatchesRequirement(actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null) return false;
  if (isPlainRecord(actual) && isPlainRecord(expected)) {
    for (const key of Object.getOwnPropertyNames(expected)) {
      const expVal = Object.getOwnPropertyDescriptor(expected, key)?.value;
      const actVal = readOwnValue(actual, key);
      if (!claimValueMatchesRequirement(actVal, expVal)) return false;
    }
    return true;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function seededUserSatisfiesRequiredCustomClaims(
  seededUser: ProbeUser | undefined,
  requiredClaims: Record<string, unknown>,
): boolean {
  const customClaims = seededUser?.customClaims;
  for (const key of Object.getOwnPropertyNames(requiredClaims)) {
    if (key === 'email_verified') continue;
    const actual = readOwnValue(customClaims, key);
    if (isExistenceClaim(requiredClaims, key)) {
      if (actual === undefined || actual === null) return false;
      continue;
    }
    const expected = Object.getOwnPropertyDescriptor(requiredClaims, key)?.value;
    if (!claimValueMatchesRequirement(actual, expected)) return false;
  }
  return true;
}

export function classifySeededOwnerClaimMismatch(
  seededOwner: ProbeUser | undefined,
  requiredClaims: Record<string, unknown>,
): string | undefined {
  const ownerVerified = seededOwner?.emailVerified === true;
  if (
    typeof requiredClaims.email_verified === 'boolean'
    && requiredClaims.email_verified !== ownerVerified
  ) {
    if (ownerVerified) {
      return 'seeded owner account has emailVerified: true while rule requires unverified email';
    }
    return 'seeded owner account has emailVerified: false while rule requires verified email';
  }
  if (!seededUserSatisfiesRequiredCustomClaims(seededOwner, requiredClaims)) {
    return 'seeded owner account lacks custom claims required by rule';
  }
  return undefined;
}

export function mergeActorClaims(
  baseActor: ProbeActor,
  extractedClaims: Readonly<Record<string, unknown>>,
  seededUser: ProbeUser | undefined,
): ProbeActor {
  const token: Record<string, unknown> = {};
  copyOwnTokenFields(token, baseActor.token);
  if (baseActor.synthetic !== false) {
    copyOwnTokenFields(token, extractedClaims);
  }
  if (seededUser?.customClaims !== undefined) {
    copyOwnTokenFields(token, seededUser.customClaims);
  }
  if (!baseActor.synthetic) {
    setOwnTokenField(token, 'email_verified', seededUser?.emailVerified === true);
  }
  return { ...baseActor, token };
}

export function buildCounterfactualClaimActor(
  baseActor: ProbeActor,
  extractedClaims: Readonly<Record<string, unknown>>,
  seededUser: ProbeUser | undefined,
): ProbeActor {
  const token: Record<string, unknown> = {};
  copyOwnTokenFields(token, baseActor.token);
  if (seededUser?.customClaims !== undefined) {
    copyOwnTokenFields(token, seededUser.customClaims);
  }
  copyOwnTokenFields(token, extractedClaims);
  if (typeof extractedClaims.email_verified === 'boolean') {
    setOwnTokenField(token, 'email_verified', extractedClaims.email_verified);
  }
  return { ...baseActor, token };
}

function initialFirestoreDocPaths(state: WorldState | undefined): Set<string> {
  if (state?.firestore) return new Set(Object.keys(state.firestore));
  const snapshotDocs = state?.snapshot?.firestore['(default)'];
  if (snapshotDocs) return new Set(Object.keys(snapshotDocs));
  return new Set();
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
  if (
    step.path === ''
    && step.method === 'update'
    && step.data
    && typeof step.data === 'object'
    && !Array.isArray(step.data)
  ) {
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

export function extractProbeClaims(
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
