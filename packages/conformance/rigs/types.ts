/**
 * Typed rig manifest data.
 *
 * A "rig" is a capture program: a script that probes either a real Firebase
 * project or an installed Firebase SDK and freezes what it observes as
 * `scripts/oracle/observations/<prefix>*.json` files. One authored
 * `RigManifestRecord` lives per file in `scripts/oracle/rigs/`, named
 * `<rig-id>.ts` — see `load.ts` for how the directory becomes the index.
 */

/**
 * How a rig is run:
 *  - 'unattended'      — no secrets, no network; safe to run anywhere, anytime.
 *  - 'credentialed'    — needs a provisioned secret (an env var) and reaches a
 *                        real Firebase project over the network.
 *  - 'human-witnessed' — requires a person present to drive or observe the
 *                        run. Not used by any current rig; reserved for a rig
 *                        that cannot be scripted end-to-end (e.g. a manual
 *                        console step with no API equivalent).
 */
export type RigAutomation = 'unattended' | 'credentialed' | 'human-witnessed';

export interface RigEnvRequirement {
  /** Exact environment variable name. */
  name: string;
  /** What the variable holds and how the rig uses it. */
  description: string;
  /** The exact IAM/API permission the credential must be scoped to, if any. */
  permission?: string;
}

/**
 * The record authored in each `scripts/oracle/rigs/<id>.ts` file. `id` is
 * deliberately absent here — the loader derives it from the filename so the
 * rig's key exists in exactly one place (the filename itself).
 */
export interface RigManifestRecord {
  description: string;
  /** Repo-relative path to the rig's runnable script; must exist on disk. */
  script: string;
  /** Exact filename prefixes (`scripts/oracle/observations/<prefix>*.json`) this
   *  rig produces AND has at least one captured observation for. Every entry is
   *  validated to match a real observation file. */
  observationPrefixes: string[];
  /** Prefixes this rig WILL produce once captured, but has NO observation for
   *  yet — staged machinery ahead of the first capture (e.g. a rules oracle
   *  whose credentialed run hasn't been performed). Validated to be a
   *  recognized surface prefix and to have NO observation yet; the moment a
   *  capture lands, validation fails until the prefix is promoted into
   *  `observationPrefixes`. Omit when every prefix the rig produces already has
   *  a capture. The union of `observationPrefixes` and `pendingPrefixes` must be
   *  non-empty and the two must not overlap. */
  pendingPrefixes?: string[];
  automation: RigAutomation;
  network: 'none' | 'firebase-production';
  requires: {
    env: RigEnvRequirement[];
    /** Firebase-project-side setup (console toggles, rules, provisioned resources) — not locally verifiable. */
    projectFeatures: string[];
    /** Local filesystem / workspace state the rig depends on beyond env vars — not locally verifiable beyond simple existence checks. */
    local: string[];
  };
  safety: {
    /** What the rig writes, and where, when it actually runs. */
    writes: string;
    /** How (and how completely) the rig cleans up after itself. */
    cleanup: string;
    /** Whether it is safe to run this rig with nobody watching (e.g. in CI). */
    unattendedSafe: boolean;
  };
  freshness: {
    /** Which field in the observation envelope pins the SDK version this rig captured against. */
    versionField: 'fbSdkVersion' | 'adminSdkVersion';
    /** How that field is enforced to stay current. */
    policy: string;
  };
}

/** The loaded shape: the authored record plus the id the loader derived from the filename. */
export interface RigManifest extends RigManifestRecord {
  id: string;
}

/**
 * One capture probe against the installed firebase-admin app registry. The
 * observation filename (`scripts/oracle/observations/<name>.json`) IS the
 * probe filename (`scripts/oracle/probes/<name>.ts`) minus its extension —
 * neither side carries a separate `name` field, so the two cannot drift apart.
 */
export interface Probe {
  description: string;
  /** Display prose only; machines read rowIds. Empty until admin matrix rows land. */
  matrixRow: string;
  /** Structured registry links. Empty until admin matrix rows land post-publish. */
  rowIds: string[];
  observe(): Promise<Record<string, unknown>>;
}
