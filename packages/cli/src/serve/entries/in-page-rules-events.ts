import type { LocalSandbox } from 'pyric/sandbox';
import { setRules } from 'pyric/sandbox/firestore';
import { rulesSourceRejection } from 'pyric/rules/internal';
import {
  applyStorageRulesUpdate,
  storageRulesUpdateNotice,
  type StorageRulesUpdate,
} from '../storage-rules-install.js';
import type { databaseRules as pageDatabaseRules } from './page-database-rules.js';

export interface InPageRulesDiagnostics {
  rulesDeployed: boolean;
  databaseRulesDeployed: boolean;
  storageRulesDeployed: boolean;
  rulesHash: string | null;
  databaseRulesHash: string | null;
  storageRulesHash: string | null;
}

/**
 * Subscribe an in-page sandbox to `/__pyric/events` rules hot-reload SSE.
 *
 * On the SharedWorker path, the worker owns one SSE stream for the whole
 * origin so multi-tab pages do not exhaust per-origin HTTP/1.1 connection caps.
 */
export function setupInPageRulesEvents(
  sandbox: LocalSandbox,
  databaseRules: typeof pageDatabaseRules,
  diagnostics: InPageRulesDiagnostics,
  reportError: (err: unknown) => void,
): void {
  if (typeof EventSource === 'undefined') return;
  const events = new EventSource('/__pyric/events');
  events.addEventListener('rules-changed', (e) => {
    try {
      const { rules, rulesHash } = JSON.parse((e as MessageEvent).data as string) as {
        rules: string;
        rulesHash: string;
      };
      const rejection = rulesSourceRejection(rules);
      if (rejection !== null) throw new Error(`Firestore ${rejection.message}`);
      setRules(sandbox, rules);
      diagnostics.rulesDeployed = true;
      diagnostics.rulesHash = rulesHash;
      console.info(`[pyric sandbox] firestore.rules hot-reloaded (hash ${rulesHash})`);
    } catch (err) {
      reportError(err);
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[pyric sandbox] rules hot-reload failed:', detail);
    }
  });
  events.addEventListener('rtdb-rules-update', (e) => {
    try {
      const { instance, target, rules, rulesHash, policy } = JSON.parse((e as MessageEvent).data as string) as {
        instance: string;
        target?: string;
        rules: { rules: Record<string, unknown> } | null;
        rulesHash: string | null;
        policy?: 'allow' | 'deny';
      };
      if (target !== undefined) {
        databaseRules.deployTarget(target, rules, policy);
        const status = rules === null ? 'removed' : `hot-reloaded (hash ${rulesHash})`;
        console.info(`[pyric sandbox] RTDB rules for deploy target "${target}" ${status}`);
        return;
      }
      databaseRules.deployInstance(instance, rules, policy);
      const isRemoved = rules === null;
      const isDefaultInstance =
        instance === databaseRules.defaultInstance() || databaseRules.isDefaultName(instance);
      if (isDefaultInstance) {
        diagnostics.databaseRulesDeployed = !isRemoved;
        diagnostics.databaseRulesHash = rulesHash ?? null;
      }
      if (isRemoved) {
        const effectivePolicy = policy ?? 'deny';
        console.info(
          `[pyric sandbox] RTDB rules for instance ${instance} removed; its reads/writes default to ${effectivePolicy}`,
        );
      } else {
        console.info(`[pyric sandbox] RTDB rules for instance ${instance} hot-reloaded (hash ${rulesHash})`);
      }
    } catch (err) {
      reportError(err);
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[pyric sandbox] database rules hot-reload failed:', detail);
    }
  });
  events.addEventListener('storage-rules-update', (e) => {
    void (async () => {
      const update = JSON.parse((e as MessageEvent).data as string) as StorageRulesUpdate;
      await applyStorageRulesUpdate(sandbox, update);
      const isDefaultBucket = update.bucket === undefined;
      if (isDefaultBucket) {
        diagnostics.storageRulesDeployed = update.rules !== null;
        diagnostics.storageRulesHash = update.rulesHash ?? null;
      }
      const hash = update.rules === null ? '' : ` (hash ${update.rulesHash})`;
      console.info(`[pyric sandbox] ${storageRulesUpdateNotice(update)}${hash}`);
    })().catch((err: unknown) => {
      reportError(err);
      const detail = err instanceof Error ? err.message : String(err);
      console.error('[pyric sandbox] storage rules hot-reload failed:', detail);
    });
  });
}
