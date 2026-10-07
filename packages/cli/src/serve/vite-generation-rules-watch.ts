import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { formatDatabaseRulesRemoved, formatStorageRulesRemoved } from './rules.js';
import type { SandboxSession } from './sandbox-session.js';

/**
 * Adapt Vite's watcher to the session's last-good rules reload operations.
 * The Firestore, Storage, and each Realtime Database instance's rules files are watched at
 * the paths the rules load from, whether or not they exist at startup:
 * creating, changing, or deleting any of them reloads it. A change to any
 * module file the Firestore rules import reloads, and so does creating one.
 * Files a reload newly imports are watched from then on, whether the reload
 * succeeds or fails. A change to one database instance's rules file reloads
 * only the instances that deploy that file.
 */
export function watchViteGenerationRules(input: {
  server: ViteDevServer;
  session: SandboxSession;
}): () => void {
  const { server, session } = input;
  const databaseFiles = session.databaseRulesFiles();
  const databaseFileByResolved = new Map(databaseFiles.map((file) => [path.resolve(file), file]));
  const storageFile = session.storageRulesFile();
  const storageResolved = path.resolve(storageFile);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  // The services whose files changed since the last reload. One debounce
  // covers every file, so a change to one service's file does not drop a
  // pending reload of another's.
  const pending = { firestore: false, database: new Set<string>(), storage: false };
  const onRulesChange = (file: string): void => {
    const resolvedFile = path.resolve(file);
    pending.firestore ||= session.firestoreRulesFiles().some((file) => path.resolve(file) === resolvedFile);
    const databaseFile = databaseFileByResolved.get(resolvedFile);
    if (databaseFile !== undefined) pending.database.add(databaseFile);
    pending.storage ||= resolvedFile === storageResolved;
    const isNoMatch = !pending.firestore && pending.database.size === 0 && !pending.storage;
    if (isNoMatch) {
      return;
    }
    const hasDebounce = debounce !== null;
    if (hasDebounce) {
      clearTimeout(debounce as ReturnType<typeof setTimeout>);
    }
    debounce = setTimeout(() => {
      const { firestore: isFirestoreMatch, storage: isStorageMatch } = pending;
      const changedDatabaseFiles = [...pending.database];
      pending.firestore = false;
      pending.database.clear();
      pending.storage = false;
      if (isFirestoreMatch) {
        void session.reloadFirestoreRules().then((result) => {
          server.watcher.add([...session.firestoreRulesFiles()]);
          const isReloaded = result.kind === 'reloaded';
          if (isReloaded) {
            server.config.logger.info(`  ↻ [pyric] rules reloaded (${result.rulesHash})`);
          } else {
            const isRejected = result.kind === 'rejected';
            if (isRejected) {
              server.config.logger.warn(
                `  ⚠ [pyric] rules NOT reloaded (last-good stays live): ${result.error.message}`,
              );
            }
          }
        });
      }
      for (const databaseFile of changedDatabaseFiles) {
        void session.reloadDatabaseRules(databaseFile).then((results) => {
          for (const { instance, result } of results) {
            if (result.kind === 'reloaded') {
              server.config.logger.info(`  ↻ [pyric] rtdb rules reloaded for ${instance} (${result.rulesHash})`);
            } else if (result.kind === 'rejected') {
              server.config.logger.warn(
                `  ⚠ [pyric] rtdb rules NOT reloaded for ${instance} (last-good stays live): ${result.error.message}`,
              );
            } else if (result.kind === 'removed') {
              server.config.logger.warn(`  ⚠ [pyric] ${formatDatabaseRulesRemoved(databaseFile, result.policy, instance)}`);
            }
          }
        });
      }
      if (isStorageMatch) {
        void session.reloadStorageRules().then((result) => {
          if (result.kind === 'reloaded') {
            server.config.logger.info(`  ↻ [pyric] storage rules reloaded (${result.rulesHash})`);
          } else if (result.kind === 'rejected') {
            server.config.logger.warn(
              `  ⚠ [pyric] storage rules NOT reloaded (last-good stays live): ${result.error.message}`,
            );
          } else if (result.kind === 'removed') {
            server.config.logger.warn(`  ⚠ [pyric] ${formatStorageRulesRemoved(storageFile)}`);
          }
        });
      }
    }, 150);
  };

  server.watcher.add([...session.firestoreRulesFiles(), ...databaseFiles, storageFile]);
  server.watcher.on('change', onRulesChange);
  server.watcher.on('add', onRulesChange);
  server.watcher.on('unlink', onRulesChange);
  return () => {
    const hasDebounce = debounce !== null;
    if (hasDebounce) {
      clearTimeout(debounce as ReturnType<typeof setTimeout>);
    }
    server.watcher.off('change', onRulesChange);
    server.watcher.off('add', onRulesChange);
    server.watcher.off('unlink', onRulesChange);
  };
}
