/**
 * Rules override normalization and filesystem hot-reload watchers for
 * `startServe`. Kept beside `serve-runtime.ts` so each module stays focused.
 */
import type { Server } from 'node:http';
import { withDefaultFirestoreRules, type FirebaseJson } from './firebase-json.js';
import type { PyricConfig } from './pyric-config.js';
import { watchRulesFiles } from '../serve/rules-files-watch.js';
import {
  formatFirestoreReloadNotes,
  formatFirestoreWatcherErrorNote,
} from '../serve/firestore-project-rules.js';
import {
  formatDatabaseRulesRemoved,
  formatStorageRulesRemoved,
  storageBucketSuffix,
} from '../serve/rules.js';
import type { SandboxSession } from '../serve/sandbox-session.js';
import { createVerifyHint } from '../serve/verify-hint.js';

export function serveErrorMessage(error: unknown): string {
  const isError = error instanceof Error;
  if (isError) return error.message;
  return String(error);
}

export function applyPyricRuleOverrides(
  config: FirebaseJson | null,
  ruleOverrides: PyricConfig['rules'],
): FirebaseJson | null {
  const hasRuleOverrides = ruleOverrides !== undefined && ruleOverrides !== '';
  if (!hasRuleOverrides) return config;
  const next: FirebaseJson = config ?? {};
  const isFirestorePath = typeof ruleOverrides === 'string';
  if (isFirestorePath) {
    next.firestore = withDefaultFirestoreRules(next.firestore, ruleOverrides);
    return next;
  }
  const firestoreOverride = ruleOverrides.firestore;
  const hasFirestoreOverride = firestoreOverride !== undefined && firestoreOverride !== '';
  if (hasFirestoreOverride) {
    next.firestore = withDefaultFirestoreRules(next.firestore, firestoreOverride);
  }
  const hasDatabaseOverride = Boolean(ruleOverrides.database);
  if (hasDatabaseOverride) {
    // The override names one rules file, so it deploys to the default
    // instance in place of any per-instance configuration.
    next.database = { rules: ruleOverrides.database };
  }
  const hasStorageOverride = Boolean(ruleOverrides.storage);
  if (hasStorageOverride) {
    const storageConfig = next.storage;
    const isSingleStorageConfig = typeof storageConfig === 'object' && !Array.isArray(storageConfig);
    const baseStorage = isSingleStorageConfig ? storageConfig : {};
    next.storage = { ...baseStorage, rules: ruleOverrides.storage };
  }
  return next;
}

export interface ServeRulesWatchersOptions {
  session: SandboxSession;
  server: Server;
  live: boolean;
  logger: { note(message: string): void };
}

/**
 * Watches Firestore, Realtime Database, and Storage rules files and dispatches
 * debounced reloads until `server` closes.
 */
export function attachServeRulesWatchers(opts: ServeRulesWatchersOptions): void {
  const { session, server, live, logger } = opts;
  const getVerifyHint = createVerifyHint({
    live,
    capturePath: session.summary.capturePath,
  });

  // Firestore rules and every module file they import are watched.
  {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const changedFirestoreFiles = new Set<string>();
    const rulesFiles = watchRulesFiles(
      () => session.firestoreRulesFiles(),
      (file) => {
        changedFirestoreFiles.add(file);
        if (debounce !== null) clearTimeout(debounce);
        debounce = setTimeout(() => {
          const files = [...changedFirestoreFiles];
          changedFirestoreFiles.clear();
          for (const changed of files) {
            void session.reloadFirestoreDatabaseRules(changed).then((results) => {
              rulesFiles.sync();
              const hasReloaded = results.some((entry) => entry.result.kind === 'reloaded');
              const hint = hasReloaded ? getVerifyHint('firestore', changed) : '';
              for (const line of formatFirestoreReloadNotes(results, hint)) {
                logger.note(line);
              }
            });
          }
        }, 150);
      },
      (error) => {
        logger.note(formatFirestoreWatcherErrorNote(serveErrorMessage(error)));
      },
    );
    server.once('close', () => {
      if (debounce !== null) clearTimeout(debounce);
      rulesFiles.close();
    });
  }

  // Each Realtime Database instance's rules file is watched the same way.
  {
    let debounceDb: ReturnType<typeof setTimeout> | null = null;
    const changedDatabaseFiles = new Set<string>();
    const dbRulesFiles = watchRulesFiles(
      () => session.databaseRulesFiles(),
      (file) => {
        changedDatabaseFiles.add(file);
        if (debounceDb !== null) clearTimeout(debounceDb);
        debounceDb = setTimeout(() => {
          const files = [...changedDatabaseFiles];
          changedDatabaseFiles.clear();
          for (const changed of files) {
            void session.reloadDatabaseRules(changed).then((results) => {
              for (const { instance, file: source, result } of results) {
                if (result.kind === 'reloaded') {
                  logger.note(
                    `  \u21bb rtdb rules reloaded for ${instance} (hash ${result.rulesHash}) \u2192 ${result.clients} page(s)${getVerifyHint('database', changed)}`,
                  );
                  if (result.fixtureCheck && result.fixtureCheck.ran > 0) {
                    for (const line of result.fixtureCheck.lines) logger.note(line);
                  }
                } else if (result.kind === 'rejected') {
                  logger.note(`  \u26a0 rtdb rules NOT reloaded for ${instance} (last-good stays live): ${result.error.message}`);
                } else if (result.kind === 'removed') {
                  logger.note(`  \u26a0 ${formatDatabaseRulesRemoved(source, result.policy, instance)} \u2192 ${result.clients} page(s)`);
                }
              }
            });
          }
        }, 150);
      },
      (error) => {
        const message = serveErrorMessage(error);
        logger.note(`  \u26a0 rtdb rules watcher failed (hot reload off): ${message}`);
      },
    );
    server.once('close', () => {
      if (debounceDb !== null) clearTimeout(debounceDb);
      dbRulesFiles.close();
    });
  }

  // Each bucket's Storage rules file is watched the same way.
  {
    let debounceStorage: ReturnType<typeof setTimeout> | null = null;
    const changedStorageFiles = new Set<string>();
    const storageRulesFiles = watchRulesFiles(
      () => session.storageRulesFiles(),
      (file) => {
        changedStorageFiles.add(file);
        if (debounceStorage !== null) clearTimeout(debounceStorage);
        debounceStorage = setTimeout(() => {
          const files = [...changedStorageFiles];
          changedStorageFiles.clear();
          for (const changed of files) {
            void session.reloadStorageRules(changed).then((results) => {
              storageRulesFiles.sync();
              for (const { bucket, target, file: source, result } of results) {
                const named = storageBucketSuffix(bucket, target);
                if (result.kind === 'reloaded') {
                  logger.note(
                    `  \u21bb storage rules reloaded${named} (hash ${result.rulesHash}) \u2192 ${result.clients} page(s)${getVerifyHint('storage', changed)}`,
                  );
                } else if (result.kind === 'rejected') {
                  logger.note(`  \u26a0 storage rules NOT reloaded (last-good stays live): ${result.error.message}${named}`);
                } else if (result.kind === 'removed') {
                  logger.note(`  \u26a0 ${formatStorageRulesRemoved(source, result.policy, bucket, target)} \u2192 ${result.clients} page(s)`);
                }
              }
            });
          }
        }, 150);
      },
      (error) => {
        const message = serveErrorMessage(error);
        logger.note(`  \u26a0 storage rules watcher failed (hot reload off): ${message}`);
      },
    );
    server.once('close', () => {
      if (debounceStorage !== null) clearTimeout(debounceStorage);
      storageRulesFiles.close();
    });
  }
}
