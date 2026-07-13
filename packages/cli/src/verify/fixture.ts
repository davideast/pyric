import type { EventService, Sandbox, SandboxEvent } from 'pyric/sandbox';
import { getStorageSandbox } from 'pyric/storage';
import { isRtdbRulesJson } from '../rtdb/rules-json.js';

export const VERIFY_FIXTURE_SCHEMA = 'pyric.verify.fixture.v1' as const;

export interface VerifyFirestoreRulesBlock {
  format: 'firestore.rules';
  source: string;
}

export interface VerifyRtdbRulesBlock {
  format: 'rtdb.rules.json';
  json: { rules: Record<string, unknown> };
}

export interface VerifyStorageRulesBlock {
  format: 'storage.rules';
  source: string;
}

export interface PyricVerifyFixture {
  schema: typeof VERIFY_FIXTURE_SCHEMA;
  description?: string;
  createdAt?: string;
  /** Opaque id of the sandbox instance that produced this capture (the served
   *  SharedWorker's `instanceId`). Purely additive: `pyric verify` ignores it.
   *  Present only on captures written by the worker's capture flush; used by
   *  boot-time event hydration to SKIP priming a capture that belongs to a
   *  DIFFERENT instance (e.g. another browser profile sharing one `pyric dev`),
   *  so someone else's session never shows up as yours. Absent on older /
   *  standalone captures → hydration primes best-effort. */
  capturedBy?: string;
  events: SandboxEvent[];
  services: {
    firestore?: {
      rules: VerifyFirestoreRulesBlock;
      state: { documents: Record<string, Record<string, unknown>> };
    };
    rtdb?: {
      rules: VerifyRtdbRulesBlock;
      state: { tree: unknown };
      databaseUrl?: string;
    };
    auth?: {
      state: {
        users?: unknown[];
        currentUser?: unknown;
      };
    };
    storage?: {
      /** RULES TEXT ONLY — captured object state is a separate, larger
       *  redesign (persistence.ts's IDB blob store) and is deliberately
       *  left untouched here. `state` stays `null` until that lands. */
      rules: VerifyStorageRulesBlock;
      state: unknown;
    };
    [service: string]: unknown;
  };
}

export interface BuildVerifyFixtureInput {
  sandbox: Pick<Sandbox, 'history' | 'snapshot'> & { currentUser?: unknown };
  description?: string;
  firestoreRules?: string | null;
  rtdbRules?: { rules: Record<string, unknown> } | null;
  rtdbState?: unknown;
  rtdbDatabaseUrl?: string | null;
  /** Currently-deployed storage rules text. RULES ONLY — there is no
   *  `storageState` input; captured storage OBJECTS are a separate,
   *  larger redesign left untouched by this fixture. */
  storageRules?: string | null;
  authState?: {
    users?: unknown[];
    currentUser?: unknown;
  } | null;
  createdAt?: string;
  /** Stamped into the fixture as `capturedBy` (identity for boot-time event
   *  hydration). Omit for `pyric verify` builds — they have no instance. */
  capturedBy?: string;
}

export function buildVerifyFixture(input: BuildVerifyFixtureInput): PyricVerifyFixture {
  const events = input.sandbox.history();
  const snapshot = input.sandbox.snapshot();
  const firestoreDocuments = snapshot.firestore;
  const services: PyricVerifyFixture['services'] = {};

  if (
    input.firestoreRules != null ||
    Object.keys(firestoreDocuments).length > 0 ||
    events.some((event) => eventService(event) === 'firestore')
  ) {
    services.firestore = {
      rules: {
        format: 'firestore.rules',
        source: input.firestoreRules ?? '',
      },
      state: { documents: firestoreDocuments },
    };
  }

  if (
    input.rtdbRules != null ||
    input.rtdbState !== undefined ||
    events.some((event) => eventService(event) === 'rtdb')
  ) {
    services.rtdb = {
      rules: {
        format: 'rtdb.rules.json',
        json: input.rtdbRules ?? { rules: {} },
      },
      state: { tree: input.rtdbState ?? null },
      ...(input.rtdbDatabaseUrl ? { databaseUrl: input.rtdbDatabaseUrl } : {}),
    };
  }

  if (
    input.storageRules != null ||
    events.some((event) => eventService(event) === 'storage')
  ) {
    services.storage = {
      rules: {
        format: 'storage.rules',
        source: input.storageRules ?? '',
      },
      // RULES TEXT ONLY (scope note above) — objects are never captured.
      state: null,
    };
  }

  const authUsers = input.authState?.users;
  const currentUser = input.authState?.currentUser ?? input.sandbox.currentUser;
  if ((authUsers && authUsers.length > 0) || currentUser != null) {
    services.auth = {
      state: {
        ...(authUsers ? { users: authUsers } : {}),
        ...(currentUser != null ? { currentUser } : {}),
      },
    };
  }

  return {
    schema: VERIFY_FIXTURE_SCHEMA,
    ...(input.description ? { description: input.description } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.capturedBy ? { capturedBy: input.capturedBy } : {}),
    events,
    services,
  };
}

export function parseVerifyFixture(value: unknown): PyricVerifyFixture {
  if (!isVerifyFixtureObject(value)) {
    throw new Error('fixture must be a JSON object.');
  }
  if (value.schema !== VERIFY_FIXTURE_SCHEMA) {
    throw new Error(`fixture schema must be '${VERIFY_FIXTURE_SCHEMA}'.`);
  }
  if (!Array.isArray(value.events)) {
    throw new Error('fixture.events must be an array.');
  }
  if (!isVerifyFixtureObject(value.services)) {
    throw new Error('fixture.services must be an object.');
  }

  const services = value.services;
  if (services.firestore !== undefined) {
    assertFirestoreService(services.firestore);
  }
  if (services.rtdb !== undefined) {
    assertRtdbService(services.rtdb);
  }
  if (services.storage !== undefined) {
    assertStorageService(services.storage);
  }
  if (services.auth !== undefined && !isVerifyFixtureObject(services.auth)) {
    throw new Error('fixture.services.auth must be an object.');
  }

  return value as unknown as PyricVerifyFixture;
}

export function fixtureVerifiableServices(
  fixture: PyricVerifyFixture,
): Array<'firestore' | 'rtdb'> {
  const services: Array<'firestore' | 'rtdb'> = [];
  if (fixture.services.firestore) services.push('firestore');
  if (fixture.services.rtdb) services.push('rtdb');
  return services;
}

function assertFirestoreService(value: unknown): void {
  if (!isVerifyFixtureObject(value)) throw new Error('fixture.services.firestore must be an object.');
  if (!isVerifyFixtureObject(value.rules) || value.rules.format !== 'firestore.rules' || typeof value.rules.source !== 'string') {
    throw new Error('fixture.services.firestore.rules must contain firestore.rules source.');
  }
  if (!isVerifyFixtureObject(value.state) || !isVerifyFixtureObject(value.state.documents)) {
    throw new Error('fixture.services.firestore.state.documents must be an object.');
  }
}

function assertRtdbService(value: unknown): void {
  if (!isVerifyFixtureObject(value)) throw new Error('fixture.services.rtdb must be an object.');
  if (
    !isVerifyFixtureObject(value.rules) ||
    value.rules.format !== 'rtdb.rules.json' ||
    !isRtdbRulesJson(value.rules.json)
  ) {
    throw new Error('fixture.services.rtdb.rules must contain RTDB rules JSON.');
  }
  if (!isVerifyFixtureObject(value.state) || !('tree' in value.state)) {
    throw new Error('fixture.services.rtdb.state.tree is required.');
  }
}

function assertStorageService(value: unknown): void {
  if (!isVerifyFixtureObject(value)) throw new Error('fixture.services.storage must be an object.');
  if (
    !isVerifyFixtureObject(value.rules) ||
    value.rules.format !== 'storage.rules' ||
    typeof value.rules.source !== 'string'
  ) {
    throw new Error('fixture.services.storage.rules must contain storage.rules source.');
  }
}

/**
 * Re-deploy a fixture's captured storage rules into a sandbox's storage
 * evaluator. RULES TEXT ONLY, mirroring the capture-side scope note: this
 * never touches storage OBJECTS (persistence.ts's IDB blob store) — only
 * `fixture.services.storage.rules.source` is applied.
 *
 * Storage rules are honored only on the FIRST `getStorageSandbox` call per
 * `Sandbox` (see `storage/service.ts`), so this must run before any other
 * code opens the storage service on `sandbox` — exactly the same ordering
 * constraint firestore/rtdb rules already have at restore time. A no-op
 * when the fixture carries no storage block.
 */
export function restoreStorageRulesFromFixture(
  fixture: PyricVerifyFixture,
  sandbox: Sandbox,
): void {
  const source = fixture.services.storage?.rules?.source;
  if (source === undefined) return;
  getStorageSandbox(sandbox, { rules: source });
}

function eventService(event: SandboxEvent): EventService {
  if ('service' in event && typeof event.service === 'string') {
    return event.service as EventService;
  }
  return 'firestore';
}

function isVerifyFixtureObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
