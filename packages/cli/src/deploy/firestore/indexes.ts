/**
 * Firestore composite-index deploy + status polling. Pure-fetch
 * over the Firestore Admin v1 API. Wire types mirror
 * `firestore.indexes.json` shape.
 */

import { AdminApiError, type ProjectScope } from '../scope.js';

const FIRESTORE_ADMIN_API = 'https://firestore.googleapis.com/v1';

export type QueryScope = 'COLLECTION' | 'COLLECTION_GROUP';
export type IndexFieldOrder = 'ASCENDING' | 'DESCENDING';
export type ArrayConfig = 'CONTAINS';
export type IndexState = 'CREATING' | 'READY' | 'NEEDS_REPAIR';

export type ApiScope =
  | 'ANY_API'
  | 'DATASTORE_MODE_API'
  | 'MONGODB_COMPATIBLE_API';

export type Density =
  | 'DENSE'
  | 'SPARSE_ALL'
  | 'SPARSE_ANY'
  | 'DENSITY_UNSPECIFIED';

export interface VectorConfig {
  dimension: number;
  flat?: Record<string, never>;
}

export interface IndexField {
  fieldPath: string;
  order?: IndexFieldOrder;
  arrayConfig?: ArrayConfig;
  vectorConfig?: VectorConfig;
}

/** Wire shape of an index — POST body to `.../indexes`. */
export interface Index {
  /** Server-assigned. Present on read responses, not create requests. */
  name?: string;
  queryScope: QueryScope;
  fields: IndexField[];
  /** Server-assigned. */
  state?: IndexState;
  apiScope?: ApiScope;
  density?: Density;
  multikey?: boolean;
  unique?: boolean;
}

export interface IndexesConfigEntry extends Index {
  collectionGroup: string;
}

export interface IndexesConfig {
  indexes: IndexesConfigEntry[];
  fieldOverrides?: unknown[];
}

export interface IndexOperation {
  name: string;
  done?: boolean;
  error?: { code: number; message: string };
  response?: Index;
}

export interface DeployIndexesOptions {
  databaseId?: string;
}

/**
 * Create a single composite index. Primitive — throws
 * `AdminApiError` on non-2xx. Returns the long-running-operation
 * handle on success.
 */
export async function create(
  scope: ProjectScope,
  entry: IndexesConfigEntry,
  options: DeployIndexesOptions = {},
): Promise<IndexOperation> {
  const token = await scope.resolveToken();
  const databaseId = options.databaseId ?? '(default)';
  const url = `${FIRESTORE_ADMIN_API}/projects/${encodeURIComponent(scope.projectId)}/databases/${encodeURIComponent(databaseId)}/collectionGroups/${encodeURIComponent(entry.collectionGroup)}/indexes`;
  const body = entryToCreateBody(entry);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new AdminApiError(
      res.status,
      await res.text(),
      `Failed to create index: ${res.status}`,
    );
  }
  return (await res.json()) as IndexOperation;
}

function entryToCreateBody(entry: IndexesConfigEntry): Index {
  const body: Index = {
    queryScope: entry.queryScope,
    fields: entry.fields,
  };
  if (entry.apiScope) body.apiScope = entry.apiScope;
  if (entry.density) body.density = entry.density;
  if (entry.multikey !== undefined) body.multikey = entry.multikey;
  if (entry.unique !== undefined) body.unique = entry.unique;
  return body;
}

function summarizeIndexFields(entry: IndexesConfigEntry): string[] {
  return entry.fields.map((f) => {
    if (f.arrayConfig) return `${f.fieldPath}:${f.arrayConfig}`;
    if (f.vectorConfig) return `${f.fieldPath}:VECTOR(${f.vectorConfig.dimension})`;
    return `${f.fieldPath}:${f.order ?? 'ASCENDING'}`;
  });
}

export interface PerIndexOutcome {
  collectionGroup: string;
  fieldsSummary: string[];
  status: 'started' | 'already-exists' | 'failed';
  operationName?: string;
  error?: { httpStatus: number; message: string };
}

export type DeployIndexesOutcome =
  | {
      ok: true;
      operationsStarted: IndexOperation[];
      alreadyExists: number;
      perIndex: PerIndexOutcome[];
    }
  | {
      ok: false;
      code:
        | 'permission-denied'
        | 'invalid-config'
        | 'create-failed'
        | 'unknown';
      message: string;
      partial?: {
        operationsStarted: IndexOperation[];
        alreadyExists: number;
        perIndex: PerIndexOutcome[];
      };
    };

/**
 * Batch-deploy a `firestore.indexes.json`-shaped config. Per-entry
 * status (`started` / `already-exists` / `failed`); aborts the
 * batch on `403`; on `ok: false` carries `partial` data so callers
 * don't lose info about what did succeed.
 */
export async function deployAll(
  scope: ProjectScope,
  config: IndexesConfig,
  options: DeployIndexesOptions = {},
): Promise<DeployIndexesOutcome> {
  const validation = validateIndexesConfig(config);
  if (!validation.ok) {
    return { ok: false, code: 'invalid-config', message: validation.message };
  }

  const databaseId = options.databaseId ?? '(default)';
  const operationsStarted: IndexOperation[] = [];
  const perIndex: PerIndexOutcome[] = [];
  let alreadyExists = 0;

  for (const entry of config.indexes) {
    const fieldsSummary = summarizeIndexFields(entry);
    try {
      const op = await create(scope, entry, { databaseId });
      operationsStarted.push(op);
      perIndex.push({
        collectionGroup: entry.collectionGroup,
        fieldsSummary,
        status: 'started',
        operationName: op.name,
      });
    } catch (e) {
      if (e instanceof AdminApiError) {
        if (e.status === 403) {
          return {
            ok: false,
            code: 'permission-denied',
            message: e.message,
            partial: { operationsStarted, alreadyExists, perIndex },
          };
        }
        if (e.status === 409) {
          alreadyExists++;
          perIndex.push({
            collectionGroup: entry.collectionGroup,
            fieldsSummary,
            status: 'already-exists',
          });
          continue;
        }
        perIndex.push({
          collectionGroup: entry.collectionGroup,
          fieldsSummary,
          status: 'failed',
          error: { httpStatus: e.status, message: e.body || e.message },
        });
        continue;
      }
      const message = e instanceof Error ? e.message : String(e);
      perIndex.push({
        collectionGroup: entry.collectionGroup,
        fieldsSummary,
        status: 'failed',
        error: { httpStatus: 0, message },
      });
      return {
        ok: false,
        code: 'create-failed',
        message,
        partial: { operationsStarted, alreadyExists, perIndex },
      };
    }
  }

  const failed = perIndex.filter((p) => p.status === 'failed');
  if (failed.length > 0) {
    return {
      ok: false,
      code: 'create-failed',
      message: `${failed.length} of ${config.indexes.length} indexes failed to create`,
      partial: { operationsStarted, alreadyExists, perIndex },
    };
  }
  return { ok: true, operationsStarted, alreadyExists, perIndex };
}

interface IndexesConfigValidation { ok: boolean; message: string }

function validateIndexesConfig(config: IndexesConfig): IndexesConfigValidation {
  if (!config || typeof config !== 'object') {
    return { ok: false, message: 'config must be an object' };
  }
  if (!Array.isArray(config.indexes)) {
    return { ok: false, message: 'config.indexes must be an array' };
  }
  for (let i = 0; i < config.indexes.length; i++) {
    const entry = config.indexes[i];
    const prefix = `indexes[${i}]`;
    if (!entry || typeof entry !== 'object') {
      return { ok: false, message: `${prefix} must be an object` };
    }
    if (!entry.collectionGroup || typeof entry.collectionGroup !== 'string') {
      return { ok: false, message: `${prefix}.collectionGroup must be a non-empty string` };
    }
    if (entry.queryScope !== 'COLLECTION' && entry.queryScope !== 'COLLECTION_GROUP') {
      return { ok: false, message: `${prefix}.queryScope must be COLLECTION or COLLECTION_GROUP` };
    }
    if (!Array.isArray(entry.fields) || entry.fields.length === 0) {
      return { ok: false, message: `${prefix}.fields must be a non-empty array` };
    }
    for (let j = 0; j < entry.fields.length; j++) {
      const f = entry.fields[j];
      const fPrefix = `${prefix}.fields[${j}]`;
      if (!f || typeof f !== 'object') {
        return { ok: false, message: `${fPrefix} must be an object` };
      }
      if (!f.fieldPath || typeof f.fieldPath !== 'string') {
        return { ok: false, message: `${fPrefix}.fieldPath must be a non-empty string` };
      }
      const variants = [f.order, f.arrayConfig, f.vectorConfig].filter((v) => v !== undefined).length;
      if (variants !== 1) {
        return { ok: false, message: `${fPrefix} must specify exactly one of order, arrayConfig, or vectorConfig` };
      }
    }
  }
  return { ok: true, message: '' };
}

export type GetIndexStatusOutcome =
  | {
      ok: true;
      state: 'CREATING' | 'NOT_FOUND';
      operationName: string;
    }
  | {
      ok: true;
      state: IndexState;
      operationName: string;
      index?: {
        name: string;
        fields: { fieldPath: string; order?: string; arrayConfig?: string }[];
      };
    }
  | {
      ok: false;
      code: 'permission-denied' | 'build-failed' | 'unknown';
      message: string;
    };

/**
 * Poll a long-running index build operation. `operationName` is
 * the opaque resource path returned by `create` /
 * `deployAll(..).operationsStarted[].name`.
 */
export async function getStatus(
  scope: ProjectScope,
  operationName: string,
): Promise<GetIndexStatusOutcome> {
  if (!operationName || typeof operationName !== 'string') {
    return { ok: false, code: 'unknown', message: 'operationName is required' };
  }
  const token = await scope.resolveToken();

  let res: Response;
  try {
    res = await fetch(`${FIRESTORE_ADMIN_API}/${operationName}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (e) {
    return {
      ok: false,
      code: 'unknown',
      message: e instanceof Error ? e.message : String(e),
    };
  }

  if (res.status === 403) {
    return {
      ok: false,
      code: 'permission-denied',
      message: 'Caller lacks permission to read Firestore index operations',
    };
  }
  if (res.status === 404) {
    return { ok: true, state: 'NOT_FOUND', operationName };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      ok: false,
      code: 'unknown',
      message: body || `HTTP ${res.status}`,
    };
  }

  const op = (await res.json()) as IndexOperation;
  if (!op.done) return { ok: true, state: 'CREATING', operationName };
  if (op.error) {
    return {
      ok: false,
      code: 'build-failed',
      message: `Index build failed: ${op.error.message} (code ${op.error.code})`,
    };
  }

  const index = op.response;
  if (!index || !index.state) {
    return { ok: true, state: 'READY', operationName };
  }
  return {
    ok: true,
    state: index.state,
    operationName,
    index: {
      name: index.name ?? '',
      fields: index.fields.map((f) => ({
        fieldPath: f.fieldPath,
        order: f.order,
        arrayConfig: f.arrayConfig,
      })),
    },
  };
}
