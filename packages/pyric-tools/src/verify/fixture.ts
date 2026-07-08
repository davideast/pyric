import type { EventService, Sandbox, SandboxEvent } from 'pyric/sandbox';
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

export interface PyricVerifyFixture {
  schema: typeof VERIFY_FIXTURE_SCHEMA;
  description?: string;
  createdAt?: string;
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
      rules?: { format: 'storage.rules'; source: string };
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
  authState?: {
    users?: unknown[];
    currentUser?: unknown;
  } | null;
  createdAt?: string;
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

function eventService(event: SandboxEvent): EventService {
  if ('service' in event && typeof event.service === 'string') {
    return event.service as EventService;
  }
  return 'firestore';
}

function isVerifyFixtureObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
