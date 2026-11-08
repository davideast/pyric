/**
 * Probe and finding shapes for assurance probes built from an app's real
 * client writes and its owner bindings.
 */
import type { AccessService } from '../code/types.js';

/** A probe actor: a signed-in user with the token claims the rules require. */
export interface ProbeActor {
  role: 'owner' | 'peer';
  uid: string;
  email: string;
  displayName: string;
  token: Record<string, unknown>;
}

/** Placeholder for SDK sentinels in synthesized payloads; the executor turns it into the real one. */
export interface Sentinel {
  __sentinel: 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'deleteField';
  by?: number;
}

/** One operation in a probe. `admin` seeds state past the rules. */
export interface ProbeStep {
  actor: 'owner' | 'peer' | 'admin';
  service: AccessService;
  /** RTDB `set`/`update`/`remove`/`get`; Firestore/Storage `create`/`set`/`update`/`delete`/`get`/`list`. */
  method: 'set' | 'update' | 'remove' | 'create' | 'delete' | 'get' | 'list';
  /** Concrete path, no leading slash. */
  path: string;
  /** Optional non-default resource identifier (for example a named Storage bucket). */
  resourceId?: string;
  data?: unknown;
  merge?: boolean;
  /** Optional explicit payload byte count for Cloud Storage upload steps. */
  sizeBytes?: number;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

export type FindingKind =
  | 'foreign-update'
  | 'foreign-delete'
  | 'owner-forge-create'
  | 'owner-transfer'
  | 'metadata-owner-forge'
  | 'attribution-spoof'
  | 'foreign-slot-write'
  | 'counter-integrity'
  | 'must-allow-denied';

export type FindingOp = 'create' | 'update' | 'delete' | 'read' | 'write';

/** A probe: setup steps that must succeed, then the step under test. */
export interface Probe {
  id: string;
  kind: FindingKind;
  op: FindingOp;
  service: AccessService;
  /** The client write's path template (Firestore `{var}`, RTDB `$var`). */
  template: string;
  /** Status a hit gets: proven for strong bindings and must-allow controls, flagged otherwise. */
  status: 'proven' | 'flagged';
  /** State seeded past the rules before anything runs. */
  seed: ProbeStep[];
  /** Legitimate steps (owner writes, a control) that must be allowed; a denial makes the probe invalid. */
  setup: ProbeStep[];
  /** The step under test. */
  attack: ProbeStep;
  /** `deny` for abuse probes (a hit is the attack being allowed); `allow` for must-allow controls (a hit is a denial). */
  expect: 'deny' | 'allow';
  /** What the probe shows when it hits. */
  evidence: string;
  /** Access-site sources the probe was built from. */
  sources: string[];
  /** For must-allow probes: when set, a denial is inconclusive (the probe is invalid) for this reason. */
  inconclusiveOnDeny?: string;
}

export type ProbeOutcome = 'hit' | 'clean' | 'invalid';

export interface StepResult {
  step: ProbeStep;
  decision: 'allow' | 'deny' | 'error';
  message?: string;
}

export interface ProbeResult {
  probe: Probe;
  outcome: ProbeOutcome;
  /** Why the probe is invalid, when it is. */
  reason?: string;
  steps: StepResult[];
}

/** A finding in `surface-report.json`. */
export interface Finding {
  path: string;
  op: FindingOp;
  kind: FindingKind;
  status: 'proven' | 'flagged';
  evidence: string;
  /** Extra detail, not part of the scored contract. */
  service?: AccessService;
  probeId?: string;
  actorUid?: string;
  /** The concrete operation that reproduced it. */
  operation?: ProbeStep;
  sources?: string[];
}
