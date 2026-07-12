import {
  GenerateIRHandler,
  RtdbMapper,
  WriteRulesHandler,
  type RtdbHost,
  type RtdbIR,
  type RtdbRulesDocument,
} from 'pyric/rules/internal/rtdb';
import { AdminApiError, type ProjectScope } from '../scope.js';
import { isRtdbRulesDocument } from '../../rtdb/rules-json.js';

const RTDB_ADMIN_API = 'https://firebasedatabase.googleapis.com/v1beta';

export type RtdbDeployRulesInput =
  | {
    rulesJson: unknown;
    databaseUrl?: string;
  }
  | {
    rules: RtdbRulesDocument;
    databaseUrl?: string;
  };

export interface RtdbFetchRulesInput {
  databaseUrl?: string;
}

export interface RtdbRulesDiscoveryResult {
  databaseUrl: string | null;
  candidates: string[];
}

function hostFor(scope: ProjectScope, databaseUrl: string): RtdbHost {
  return {
    projectId: scope.projectId,
    databaseUrl,
    resolveAdminToken: () => scope.resolveToken(),
    resolveUserToken: async () => {
      throw new Error('RTDB deploy tools do not mint user tokens');
    },
    getClientForUser: async () => {
      throw new Error('RTDB deploy tools do not create client SDK handles');
    },
  };
}

function normalizeDatabaseUrl(raw: string): string {
  const url = new URL(raw);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function extractDatabaseUrl(instance: unknown): string | null {
  if (!instance || typeof instance !== 'object') return null;
  const obj = instance as Record<string, unknown>;
  const direct = obj.databaseUrl;
  if (typeof direct === 'string' && direct.length > 0) return normalizeDatabaseUrl(direct);

  const name = obj.name;
  if (typeof name !== 'string') return null;
  const instanceId = name.split('/').filter(Boolean).at(-1);
  return instanceId ? `https://${instanceId}.firebaseio.com` : null;
}

function rulesJsonFromInput(input: RtdbDeployRulesInput): unknown {
  if ('rules' in input) {
    if (!isRtdbRulesDocument(input.rules)) {
      throw new Error('rtdb.rules.deploy: input.rules must be an RTDB rules document');
    }
    return input.rules.toJSON();
  }
  return input.rulesJson;
}

export async function discoverDefaultDatabaseUrl(scope: ProjectScope): Promise<RtdbRulesDiscoveryResult> {
  const token = await scope.resolveToken();
  const res = await fetch(
    `${RTDB_ADMIN_API}/projects/${encodeURIComponent(scope.projectId)}/locations/-/instances`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new AdminApiError(
      res.status,
      body,
      `RTDB instance discovery failed: ${res.status} ${res.statusText}`,
    );
  }

  const body = await res.json().catch(() => ({})) as { instances?: unknown[] };
  const instances = Array.isArray(body.instances) ? body.instances : [];
  const candidates = [
    ...new Set(instances.map(extractDatabaseUrl).filter((url): url is string => Boolean(url))),
  ];
  if (candidates.length === 0) return { databaseUrl: null, candidates };
  if (candidates.length === 1) return { databaseUrl: candidates[0], candidates };

  const defaultCandidates = [
    ...new Set(
      instances
        .filter((instance) => (
          typeof instance === 'object' &&
          instance !== null &&
          (instance as Record<string, unknown>).type === 'DEFAULT_DATABASE'
        ))
        .map(extractDatabaseUrl)
        .filter((url): url is string => Boolean(url)),
    ),
  ];
  return {
    databaseUrl: defaultCandidates.length === 1 ? defaultCandidates[0] : null,
    candidates,
  };
}

export async function resolveDatabaseUrl(
  scope: ProjectScope,
  explicitDatabaseUrl?: string,
): Promise<string> {
  if (explicitDatabaseUrl) return normalizeDatabaseUrl(explicitDatabaseUrl);

  const discovered = await discoverDefaultDatabaseUrl(scope);
  if (discovered.databaseUrl) return discovered.databaseUrl;

  const suffix = discovered.candidates.length > 0
    ? ` Found multiple RTDB instances: ${discovered.candidates.join(', ')}.`
    : '';
  throw new Error(
    `Could not resolve a Realtime Database URL for project '${scope.projectId}'. ` +
      `Pass --database-url, set FIREBASE_DATABASE_URL, or add "database.url" to firebase.json.${suffix}`,
  );
}

export async function fetchRules(scope: ProjectScope, input: RtdbFetchRulesInput = {}): Promise<RtdbIR> {
  const databaseUrl = await resolveDatabaseUrl(scope, input.databaseUrl);
  const result = await new GenerateIRHandler().execute(hostFor(scope, databaseUrl));
  if (!result.success) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return result.data;
}

export async function deployRules(scope: ProjectScope, input: RtdbDeployRulesInput): Promise<void> {
  const databaseUrl = await resolveDatabaseUrl(scope, input.databaseUrl);
  const ir = RtdbMapper.mapToIR(rulesJsonFromInput(input), null, databaseUrl);
  const result = await new WriteRulesHandler().execute(hostFor(scope, databaseUrl), ir);
  if (!result.success) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
}
