/**
 * Opt-in in-memory TTL cache and credential-free health summary store for
 * deployed Security Rules in Live mode (`#2363`).
 *
 * Strictly OFF by default (`enabled: false`): when disabled, zero credential
 * files are read, zero network calls are made, and `status()` returns
 * `undefined`.
 */
import { defaultDatabaseInstanceName } from 'pyric/sandbox/internal';
import {
  createDeveloperCliTokenProvider,
  type DeployedRulesAuthSource,
  type DeployedRulesTokenProvider,
} from './deployed-rules-auth.js';
import {
  compareRtdbRulesDrift,
  compareTextRulesDrift,
  type RulesDriftStatus,
} from './deployed-rules-drift.js';
import {
  resolveAllowedRtdbRulesUrl,
  type DeployedRulesFetchError,
  type DeployedRulesFetchErrorCode,
} from './deployed-rules-http.js';
import {
  DEFAULT_FIRESTORE_DATABASE,
  readDeployedFirestoreRules,
  readDeployedRtdbRules,
  readDeployedStorageRules,
  type DeployedFirestoreRulesSnapshot,
  type DeployedRtdbRulesSnapshot,
  type DeployedRulesReadResult,
  type DeployedRulesService,
  type DeployedStorageRulesSnapshot,
} from './deployed-rules.js';

export interface DeployedRulesServiceHealth {
  readonly service: DeployedRulesService;
  readonly target: string;
  readonly status: 'loaded' | 'unavailable';
  readonly releaseName?: string;
  readonly rulesetId?: string;
  readonly hash?: string;
  readonly drift?: RulesDriftStatus;
  readonly driftSummary?: string;
  readonly errorCode?: DeployedRulesFetchErrorCode;
  readonly errorMessage?: string;
}

export interface DeployedRulesHealthStatus {
  readonly enabled: true;
  readonly authSource?: DeployedRulesAuthSource;
  readonly services: readonly DeployedRulesServiceHealth[];
}

export interface DeployedRulesStoreOptions {
  /** Strictly OFF by default. Must be explicitly set to `true` to read credentials or network. */
  readonly enabled?: boolean;
  readonly projectId: string;
  readonly tokenProvider?: DeployedRulesTokenProvider;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly cacheTtlMs?: number;
  readonly timeoutMs?: number;
}

export interface DeployedRulesStore {
  readonly enabled: boolean;
  getFirestore(options?: {
    readonly databaseId?: string;
    readonly localRulesText?: string | null;
    readonly forceRefresh?: boolean;
  }): Promise<DeployedRulesReadResult<DeployedFirestoreRulesSnapshot>>;
  getStorage(options?: {
    readonly bucket?: string;
    readonly localRulesText?: string | null;
    readonly forceRefresh?: boolean;
  }): Promise<DeployedRulesReadResult<DeployedStorageRulesSnapshot>>;
  getRtdb(options?: {
    readonly databaseUrlOrInstance?: string;
    readonly localRulesText?: string | null;
    readonly forceRefresh?: boolean;
  }): Promise<DeployedRulesReadResult<DeployedRtdbRulesSnapshot>>;
  /** Credential-free summary for `/__pyric/health`. Returns `undefined` when disabled. */
  status(): DeployedRulesHealthStatus | undefined;
  clearCache(): void;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
export const MAX_DEPLOYED_RULES_CACHE_ENTRIES = 32;
const MAX_HEALTH_ENTRIES = MAX_DEPLOYED_RULES_CACHE_ENTRIES * 3;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  if (map.has(key)) {
    map.delete(key);
  } else if (map.size >= maxEntries) {
    const oldest = map.keys().next();
    if (!oldest.done) {
      map.delete(oldest.value);
    }
  }
  map.set(key, value);
}

type AnySnapshot =
  | DeployedFirestoreRulesSnapshot
  | DeployedStorageRulesSnapshot
  | DeployedRtdbRulesSnapshot;

interface CachedEntry<T extends AnySnapshot> {
  readonly snapshot: T;
  readonly expiresAt: number;
}

function healthOfLoaded(snapshot: AnySnapshot): DeployedRulesServiceHealth {
  if (snapshot.service === 'firestore') {
    return {
      service: 'firestore',
      target: snapshot.databaseId,
      status: 'loaded',
      releaseName: snapshot.releaseName,
      rulesetId: snapshot.rulesetId,
      hash: snapshot.hash,
      drift: snapshot.drift.status,
      driftSummary: snapshot.drift.summary,
    };
  }
  if (snapshot.service === 'storage') {
    return {
      service: 'storage',
      target: snapshot.bucket,
      status: 'loaded',
      releaseName: snapshot.releaseName,
      rulesetId: snapshot.rulesetId,
      hash: snapshot.hash,
      drift: snapshot.drift.status,
      driftSummary: snapshot.drift.summary,
    };
  }
  return {
    service: 'rtdb',
    target: snapshot.instance,
    status: 'loaded',
    hash: snapshot.hash,
    drift: snapshot.drift.status,
    driftSummary: snapshot.drift.summary,
  };
}

function healthOfError(
  service: DeployedRulesService,
  target: string,
  error: DeployedRulesFetchError,
): DeployedRulesServiceHealth {
  return {
    service,
    target,
    status: 'unavailable',
    errorCode: error.code,
    errorMessage: error.message,
  };
}

/**
 * Creates a strictly opt-in deployed-rules store with in-memory TTL caching
 * and credential-free health reporting.
 */
export function createDeployedRulesStore(options: DeployedRulesStoreOptions): DeployedRulesStore {
  if (options.enabled !== true) {
    const disabledResult = async <T>(): Promise<DeployedRulesReadResult<T>> => ({
      ok: false,
      disabled: true,
    });
    return {
      enabled: false,
      getFirestore: () => disabledResult<DeployedFirestoreRulesSnapshot>(),
      getStorage: () => disabledResult<DeployedStorageRulesSnapshot>(),
      getRtdb: () => disabledResult<DeployedRtdbRulesSnapshot>(),
      status: () => undefined,
      clearCache() {},
    };
  }

  const now = options.now ?? Date.now;
  const cacheTtlMs = Math.max(1_000, options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  const tokenProvider =
    options.tokenProvider ??
    createDeveloperCliTokenProvider({
      env: options.env,
      now,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
    });

  const firestoreCache = new Map<string, CachedEntry<DeployedFirestoreRulesSnapshot>>();
  const storageCache = new Map<string, CachedEntry<DeployedStorageRulesSnapshot>>();
  const rtdbCache = new Map<string, CachedEntry<DeployedRtdbRulesSnapshot>>();
  const inflight = new Map<string, Promise<unknown>>();
  const healthByKey = new Map<string, DeployedRulesServiceHealth>();
  let lastAuthSource: DeployedRulesAuthSource | undefined;

  function recordLoaded(key: string, snapshot: AnySnapshot): void {
    lastAuthSource = snapshot.authSource;
    setBounded(healthByKey, key, healthOfLoaded(snapshot), MAX_HEALTH_ENTRIES);
  }

  function recordFailure(
    key: string,
    service: DeployedRulesService,
    target: string,
    error: DeployedRulesFetchError,
  ): void {
    // Do not persist unvalidated caller-supplied raw target strings in `/__pyric/health`.
    if (error.code === 'invalid-target' || error.code === 'invalid-host') {
      return;
    }
    setBounded(healthByKey, key, healthOfError(service, target, error), MAX_HEALTH_ENTRIES);
  }

  function withInflight<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = inflight.get(key) as Promise<T> | undefined;
    if (existing !== undefined) {
      return existing;
    }
    const promise = run().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  return {
    enabled: true,

    async getFirestore(req = {}) {
      const databaseId = req.databaseId ?? DEFAULT_FIRESTORE_DATABASE;
      const key = `firestore:${databaseId}`;
      const cached = firestoreCache.get(key);
      if (req.forceRefresh !== true && cached !== undefined && cached.expiresAt > now()) {
        const refreshedDrift = compareTextRulesDrift(cached.snapshot.source, req.localRulesText, 'Firestore');
        const updated: DeployedFirestoreRulesSnapshot = { ...cached.snapshot, drift: refreshedDrift };
        recordLoaded(key, updated);
        return { ok: true, snapshot: updated };
      }

      return withInflight(key, async () => {
        const result = await readDeployedFirestoreRules({
          projectId: options.projectId,
          databaseId,
          localRulesText: req.localRulesText,
          tokenProvider,
          fetchImpl: options.fetchImpl,
          now,
          timeoutMs: options.timeoutMs,
        });
        if (result.ok) {
          setBounded(
            firestoreCache,
            key,
            { snapshot: result.snapshot, expiresAt: now() + cacheTtlMs },
            MAX_DEPLOYED_RULES_CACHE_ENTRIES,
          );
          recordLoaded(key, result.snapshot);
        } else if (!result.disabled) {
          recordFailure(key, 'firestore', databaseId, result.error);
        }
        return result;
      });
    },

    async getStorage(req = {}) {
      const trimmedBucket = req.bucket?.trim();
      let targetKey = `${options.projectId.toLowerCase()}.firebasestorage.app`;
      if (trimmedBucket !== undefined && trimmedBucket.length > 0) {
        targetKey = trimmedBucket;
      }
      const key = `storage:${targetKey}`;
      const cached = storageCache.get(key);
      if (req.forceRefresh !== true && cached !== undefined && cached.expiresAt > now()) {
        const refreshedDrift = compareTextRulesDrift(cached.snapshot.source, req.localRulesText, 'Storage');
        const updated: DeployedStorageRulesSnapshot = { ...cached.snapshot, drift: refreshedDrift };
        recordLoaded(key, updated);
        return { ok: true, snapshot: updated };
      }

      return withInflight(key, async () => {
        const result = await readDeployedStorageRules({
          projectId: options.projectId,
          bucket: req.bucket,
          localRulesText: req.localRulesText,
          tokenProvider,
          fetchImpl: options.fetchImpl,
          now,
          timeoutMs: options.timeoutMs,
        });
        if (result.ok) {
          setBounded(
            storageCache,
            key,
            { snapshot: result.snapshot, expiresAt: now() + cacheTtlMs },
            MAX_DEPLOYED_RULES_CACHE_ENTRIES,
          );
          recordLoaded(key, result.snapshot);
        } else if (!result.disabled) {
          recordFailure(key, 'storage', targetKey, result.error);
        }
        return result;
      });
    },

    async getRtdb(req = {}) {
      const trimmedTarget = req.databaseUrlOrInstance?.trim();
      let rawTarget = defaultDatabaseInstanceName(options.projectId);
      if (trimmedTarget !== undefined && trimmedTarget.length > 0) {
        rawTarget = trimmedTarget;
      }
      const canonicalUrl = resolveAllowedRtdbRulesUrl(rawTarget);
      if (canonicalUrl === null) {
        return {
          ok: false,
          error: {
            code: 'invalid-host',
            message: 'Refused Realtime Database rules lookup: target must be an allowlisted Firebase RTDB URL or instance name.',
          },
        };
      }
      const canonicalHost = new URL(canonicalUrl).hostname.toLowerCase();
      const canonicalInstance = canonicalHost.split('.')[0] ?? canonicalHost;
      const key = `rtdb:${canonicalHost}`;
      const cached = rtdbCache.get(key);
      if (req.forceRefresh !== true && cached !== undefined && cached.expiresAt > now()) {
        const refreshedDrift = compareRtdbRulesDrift(
          cached.snapshot.parsed.rules,
          cached.snapshot.hash,
          req.localRulesText,
        );
        const updated: DeployedRtdbRulesSnapshot = { ...cached.snapshot, drift: refreshedDrift };
        recordLoaded(key, updated);
        return { ok: true, snapshot: updated };
      }

      return withInflight(key, async () => {
        const result = await readDeployedRtdbRules({
          databaseUrlOrInstance: canonicalUrl,
          localRulesText: req.localRulesText,
          tokenProvider,
          fetchImpl: options.fetchImpl,
          now,
          timeoutMs: options.timeoutMs,
        });
        if (result.ok) {
          setBounded(
            rtdbCache,
            key,
            { snapshot: result.snapshot, expiresAt: now() + cacheTtlMs },
            MAX_DEPLOYED_RULES_CACHE_ENTRIES,
          );
          recordLoaded(key, result.snapshot);
        } else if (!result.disabled) {
          recordFailure(key, 'rtdb', canonicalInstance, result.error);
        }
        return result;
      });
    },

    status(): DeployedRulesHealthStatus {
      const services = [...healthByKey.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, entry]) => ({ ...entry }));
      if (lastAuthSource === undefined) {
        return { enabled: true, services };
      }
      return { enabled: true, authSource: lastAuthSource, services };
    },

    clearCache(): void {
      firestoreCache.clear();
      storageCache.clear();
      rtdbCache.clear();
      healthByKey.clear();
      lastAuthSource = undefined;
    },
  };
}
