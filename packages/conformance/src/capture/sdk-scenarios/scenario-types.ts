/**
 * SDK behavior scenarios: one scenario, two referees.
 *
 * Each scenario file drives the modular SDK through an injected module
 * namespace. `run-sdk-scenarios.ts` passes the real `firebase/firestore` or
 * `firebase/database` against the oracle project and writes the result as the
 * committed observation. The pyric suites pass `pyric/firestore` or
 * `pyric/database` (and the served worker client) through the same scenario
 * and compare the result with that observation, so the capture and its replay
 * cannot drift apart.
 */
import type * as FirestoreModule from 'firebase/firestore';
import type * as DatabaseModule from 'firebase/database';

export type FirestoreSdk = typeof FirestoreModule;
export type DatabaseSdk = typeof DatabaseModule;

/** The observation envelope fields a scenario owns. */
export interface ScenarioObservation {
  name: string;
  rowIds: string[];
  description: string;
}

/** Timing seams: production waits on real time, a replay settles at once. */
export interface ScenarioTiming {
  /** Pause so listeners and acknowledgements arrive. */
  wait(ms: number): Promise<void>;
  /** Reject with `Error('<label> timeout')` when `promise` takes longer than `ms`. */
  bounded<T>(label: string, promise: Promise<T>, ms: number): Promise<T>;
  /** Resolve when `promise` settles or `ms` passes, whichever is first. */
  within(promise: Promise<unknown>, ms: number): Promise<void>;
}

export interface FirestoreScenarioContext extends ScenarioTiming {
  fs: FirestoreSdk;
  db: FirestoreModule.Firestore;
  /** A document path the scenario writes beneath: `<base>/<collection>/<id>`. */
  base: string;
  /** A document path outside the oracle namespace, which the rules deny. */
  deniedDocPath: string;
  /** Another signed-in client of the same project. */
  newClient(name: string): Promise<{ db: FirestoreModule.Firestore }>;
}

export interface FirestoreScenario {
  observation: ScenarioObservation;
  run(ctx: FirestoreScenarioContext): Promise<Record<string, unknown>>;
}

export interface RtdbScenarioContext extends ScenarioTiming {
  rtdb: DatabaseSdk;
  db: DatabaseModule.Database;
  /** A path the scenario writes beneath, `/pyric_oracle/<runId>`. */
  base: string;
  /** Another signed-in client of the same database. */
  newClient(name: string): Promise<{ db: DatabaseModule.Database }>;
}

export interface RtdbScenario {
  observation: ScenarioObservation;
  /** Rules placed at `/pyric_oracle/$run` for the capture. Default: read and write when signed in. */
  rules?: Record<string, unknown>;
  run(ctx: RtdbScenarioContext): Promise<Record<string, unknown>>;
}

export const SIGNED_IN_RULES: Record<string, unknown> = { '.read': 'auth != null', '.write': 'auth != null' };
