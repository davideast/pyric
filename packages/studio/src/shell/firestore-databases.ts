/**
 * Declared Cloud Firestore databases, rules deployment status, and URL-synced
 * active database selection for Pyric Studio.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_FIRESTORE_DATABASE,
  getDatabaseEnv,
  listDeclaredFirestoreDatabases,
} from 'pyric/firestore/internal';
import { getInternalEnv } from 'pyric/sandbox/internal';

import { useDevSeed } from '../dev/DevSeedProvider.js';
import { useEnvironment } from './environment.js';
import { currentPath, pushPath, subscribeToLocation } from './router.js';
import {
  useServeInit,
  type ServeInitFirestoreDatabaseRule,
  type ServeInitPayload,
} from './serve-init.js';

export { DEFAULT_FIRESTORE_DATABASE };

export interface StudioFirestoreDatabaseStatus {
  /** `(default)` or a declared named database id. */
  id: string;
  /** True when `firebase.json` or `setRules` deployed explicit rules to this database. */
  rulesDeployed: boolean;
  /** Short label for chips and tooltips (`rules deployed` or `no rules deployed`). */
  rulesStatusLabel: string;
}

/** Normalize an optional database id to `undefined` for `(default)` or the named id. */
function normalizeStudioDatabaseSelection(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null || raw === '' || raw === DEFAULT_FIRESTORE_DATABASE) {
    return undefined;
  }
  return raw;
}

function deriveSelectedDatabase(): string | undefined {
  const loc = currentPath();
  if (loc.tab !== 'firestore') return undefined;
  return normalizeStudioDatabaseSelection(loc.query.database);
}

/** Two-way URL binding (`?database=<id>`, omitted for `(default)`) for the Firestore data pane. */
export function useSelectedFirestoreDatabase(): readonly [
  string | undefined,
  (databaseId: string | undefined) => void,
] {
  const selected = useSyncExternalStore(
    subscribeToLocation,
    deriveSelectedDatabase,
    () => undefined,
  );
  const setSelected = useCallback((nextId: string | undefined) => {
    const normalized = normalizeStudioDatabaseSelection(nextId);
    const loc = currentPath();
    const nextQuery: Record<string, string | undefined> = { ...loc.query };
    if (normalized === undefined) {
      delete nextQuery.database;
    } else {
      nextQuery.database = normalized;
    }
    pushPath({ tab: 'firestore', query: nextQuery });
  }, []);
  return [selected, setSelected] as const;
}

function extractServeRuleConfigured(
  entry: ServeInitFirestoreDatabaseRule | string | null | undefined,
): boolean {
  if (entry === undefined || entry === null) return false;
  if (typeof entry === 'string') return entry.trim().length > 0;
  if (entry.configured === true) return true;
  if (typeof entry.rules === 'string' && entry.rules.trim().length > 0) return true;
  if (typeof entry.rulesHash === 'string' && entry.rulesHash.length > 0) return true;
  return false;
}

function collectServedFirestoreDatabases(payload: ServeInitPayload | null): {
  declared: Set<string>;
  rulesByDb: Map<string, boolean>;
  defaultRulesDeployed: boolean;
} {
  const declared = new Set<string>();
  const rulesByDb = new Map<string, boolean>();
  let defaultRulesDeployed = false;

  if (payload) {
    if (
      (typeof payload.rules === 'string' && payload.rules.trim().length > 0) ||
      (typeof payload.rulesHash === 'string' && payload.rulesHash.length > 0)
    ) {
      defaultRulesDeployed = true;
    }
    for (const id of payload.firestoreDeclared ?? []) {
      if (id && id !== DEFAULT_FIRESTORE_DATABASE) declared.add(id);
    }
    for (const id of payload.firestoreDatabases?.declared ?? []) {
      if (id && id !== DEFAULT_FIRESTORE_DATABASE) declared.add(id);
    }
    const sources = [payload.firestoreDatabaseRules, payload.firestoreDatabases?.rules];
    for (const map of sources) {
      if (!map || typeof map !== 'object') continue;
      for (const [id, entry] of Object.entries(map)) {
        const hasRules = extractServeRuleConfigured(entry);
        if (id === DEFAULT_FIRESTORE_DATABASE) {
          if (hasRules) defaultRulesDeployed = true;
        } else if (id.length > 0) {
          declared.add(id);
          if (hasRules) rulesByDb.set(id, true);
        }
      }
    }
  }

  return { declared, rulesByDb, defaultRulesDeployed };
}

interface WorkerFirestoreSnapshotMeta {
  declared: string[];
  rules: Record<string, string>;
  defaultHasExplicitRules: boolean;
}

const EMPTY_WORKER_META: WorkerFirestoreSnapshotMeta = {
  declared: [],
  rules: {},
  defaultHasExplicitRules: false,
};

/** Reactive list of declared Firestore databases (always starting with `(default)`) and rules status. */
export function useStudioFirestoreDatabases(): StudioFirestoreDatabaseStatus[] {
  const seed = useDevSeed();
  const env = useEnvironment();
  const serve = useServeInit();
  const live = env.status === 'ready' ? env.env.live : undefined;
  const [workerMeta, setWorkerMeta] = useState<WorkerFirestoreSnapshotMeta>(EMPTY_WORKER_META);

  useEffect(() => {
    if (!live || seed.status === 'ready') {
      setWorkerMeta(EMPTY_WORKER_META);
      return;
    }
    let alive = true;
    const refresh = () => {
      live
        .getSnapshot()
        .then((snap) => {
          if (!alive) return;
          const raw = snap as unknown as {
            firestoreDeclared?: string[];
            firestoreDatabases?: Record<string, unknown>;
            firestoreDatabaseRules?: Record<string, string>;
            rules?: { firestore?: string | null };
          };
          const declaredSet = new Set<string>(raw.firestoreDeclared ?? []);
          for (const key of Object.keys(raw.firestoreDatabases ?? {})) {
            if (key !== DEFAULT_FIRESTORE_DATABASE) declaredSet.add(key);
          }
          const rulesRecord: Record<string, string> = {};
          for (const [key, val] of Object.entries(raw.firestoreDatabaseRules ?? {})) {
            if (typeof val === 'string' && val.trim().length > 0) {
              rulesRecord[key] = val;
            }
          }
          const defaultRules = raw.rules?.firestore;
          setWorkerMeta({
            declared: [...declaredSet].sort(),
            rules: rulesRecord,
            defaultHasExplicitRules:
              typeof defaultRules === 'string' && defaultRules.trim().length > 0,
          });
        })
        .catch(() => {
          /* best-effort */
        });
    };
    refresh();
    const unsub = live.feed.subscribe(() => refresh());
    return () => {
      alive = false;
      unsub();
    };
  }, [live, seed.status]);

  return useMemo<StudioFirestoreDatabaseStatus[]>(() => {
    if (seed.status === 'ready') {
      const sb = seed.handles.sandbox;
      const defaultExplicit = getInternalEnv(sb).getExplicitRules();
      const defaultDeployed = defaultExplicit !== null && defaultExplicit.trim().length > 0;
      const out: StudioFirestoreDatabaseStatus[] = [
        {
          id: DEFAULT_FIRESTORE_DATABASE,
          rulesDeployed: defaultDeployed,
          rulesStatusLabel: defaultDeployed ? 'rules deployed' : 'no rules deployed',
        },
      ];
      for (const id of listDeclaredFirestoreDatabases(sb)) {
        let deployed = false;
        try {
          const explicit = getDatabaseEnv(sb, id).getExplicitRules();
          deployed = explicit !== null && explicit.trim().length > 0;
        } catch {
          deployed = false;
        }
        out.push({
          id,
          rulesDeployed: deployed,
          rulesStatusLabel: deployed ? 'rules deployed' : 'no rules deployed',
        });
      }
      return out;
    }

    const servedPayload = serve.status === 'ready' ? serve.payload : null;
    const served = collectServedFirestoreDatabases(servedPayload);
    const allNamed = new Set<string>([...served.declared, ...workerMeta.declared]);
    const defaultDeployed = served.defaultRulesDeployed || workerMeta.defaultHasExplicitRules;
    const out: StudioFirestoreDatabaseStatus[] = [
      {
        id: DEFAULT_FIRESTORE_DATABASE,
        rulesDeployed: defaultDeployed,
        rulesStatusLabel: defaultDeployed ? 'rules deployed' : 'no rules deployed',
      },
    ];
    for (const id of [...allNamed].sort()) {
      const hasWorkerRules =
        Object.hasOwn(workerMeta.rules, id) && workerMeta.rules[id]!.trim().length > 0;
      const deployed = served.rulesByDb.get(id) === true || hasWorkerRules;
      out.push({
        id,
        rulesDeployed: deployed,
        rulesStatusLabel: deployed ? 'rules deployed' : 'no rules deployed',
      });
    }
    return out;
  }, [seed, serve, workerMeta]);
}

/** Build the runtime chip label and tooltip when named Firestore databases are declared. */
export function describeRuntimeFirestoreDatabases(
  databases: readonly StudioFirestoreDatabaseStatus[],
): { label: string; title: string } | null {
  if (databases.length <= 1) return null;
  const details = databases
    .map((entry) => `${entry.id} (${entry.rulesStatusLabel})`)
    .join(', ');
  return {
    label: `${databases.length} databases`,
    title: `Declared Firestore databases: ${details}.`,
  };
}
