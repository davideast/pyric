import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { firestoreDatabaseSuffix } from './firestore-project-rules.js';
import { formatDatabaseRulesRemoved, formatStorageRulesRemoved, storageBucketSuffix } from './rules.js';
import type { SandboxSession } from './sandbox-session.js';
import { createVerifyHint } from './verify-hint.js';

const RELOAD_GLYPH = String.fromCharCode(0x21bb);
const WARN_GLYPH = String.fromCharCode(0x26a0);

/**
 * Adapt Vite's watcher to the session's last-good rules reload operations.
 * The Firestore, Storage, and each Realtime Database instance's rules files are watched at
 * the paths the rules load from, whether or not they exist at startup:
 * creating, changing, or deleting any of them reloads it. A change to any
 * module file the Firestore rules import reloads, and so does creating one.
 * Files a reload newly imports are watched from then on, whether the reload
 * succeeds or fails. A change to one database instance's rules file reloads
 * only the instances that deploy that file. On a live host each reload line
 * says it changed the sandbox only, and gives no `pyric verify` hint.
 */
export function watchViteGenerationRules(input: {
  server: ViteDevServer;
  session: SandboxSession;
  /** The dev server is a live host (`pyricLive()`). */
  live?: boolean;
}): () => void {
  const getVerifyHint = createVerifyHint({ live: input.live });

  const { server, session } = input;
  const databaseFiles = session.databaseRulesFiles();
  const databaseFileByResolved = new Map(databaseFiles.map((file) => [path.resolve(file), file]));

  let debounce: ReturnType<typeof setTimeout> | null = null;
  // The services whose files changed since the last reload. One debounce
  // covers every file, so a change to one service's file does not drop a
  // pending reload of another's.
  const pending = { firestore: new Set<string>(), database: new Set<string>(), storage: new Set<string>() };
  const onRulesChange = (file: string): void => {
    const resolvedFile = path.resolve(file);
    const matchesFirestore = session.firestoreRulesFiles().some((candidate) => path.resolve(candidate) === resolvedFile);
    if (matchesFirestore) {
      pending.firestore.add(resolvedFile);
    }
    const databaseFile = databaseFileByResolved.get(resolvedFile);
    if (databaseFile !== undefined) pending.database.add(databaseFile);
    const storageFile = session.storageRulesFiles().find((candidate) => path.resolve(candidate) === resolvedFile);
    if (storageFile !== undefined) pending.storage.add(storageFile);
    const isNoMatch = pending.firestore.size === 0 && pending.database.size === 0 && pending.storage.size === 0;
    if (isNoMatch) {
      return;
    }
    const hasDebounce = debounce !== null;
    if (hasDebounce) {
      clearTimeout(debounce as ReturnType<typeof setTimeout>);
    }
    debounce = setTimeout(() => {
      const changedFirestoreFiles = [...pending.firestore];
      const changedDatabaseFiles = [...pending.database];
      const changedStorageFiles = [...pending.storage];
      pending.firestore.clear();
      pending.database.clear();
      pending.storage.clear();
      const logFirestoreReloads = (
        results: Awaited<ReturnType<SandboxSession['reloadFirestoreDatabaseRules']>>,
      ): void => {
        server.watcher.add([...session.firestoreRulesFiles()]);
        for (const { database, target, result } of results) {
          const named = firestoreDatabaseSuffix(database, target);
          if (result.kind === 'reloaded') {
            server.config.logger.info(
              `  ${RELOAD_GLYPH} [pyric] rules reloaded${named} (${result.rulesHash})${getVerifyHint()}`,
            );
            if (result.fixtureCheck && result.fixtureCheck.ran > 0) {
              let logFn = (m: string) => server.config.logger.warn(m);
              if (result.fixtureCheck.ok) {
                logFn = (m: string) => server.config.logger.info(m);
              }
              for (const line of result.fixtureCheck.lines) logFn(line);
            }
          } else if (result.kind === 'rejected') {
            server.config.logger.warn(
              `  ${WARN_GLYPH} [pyric] rules NOT reloaded (last-good stays live): ${result.error.message}${named}`,
            );
          }
        }
      };
      if (changedFirestoreFiles.length > 0) {
        if (typeof session.reloadFirestoreDatabaseRules === 'function') {
          for (const firestoreFile of changedFirestoreFiles) {
            void session.reloadFirestoreDatabaseRules(firestoreFile).then(logFirestoreReloads);
          }
        } else {
          void session
            .reloadFirestoreRules()
            .then((result) => logFirestoreReloads([{ file: changedFirestoreFiles[0]!, result }]));
        }
      }
      for (const databaseFile of changedDatabaseFiles) {
        void session.reloadDatabaseRules(databaseFile).then((results) => {
          for (const { instance, result } of results) {
            if (result.kind === 'reloaded') {
              server.config.logger.info(`  ↻ [pyric] rtdb rules reloaded for ${instance} (${result.rulesHash})${getVerifyHint()}`);
              if (result.fixtureCheck && result.fixtureCheck.ran > 0) {
                const logFn = result.fixtureCheck.ok
                  ? (m: string) => server.config.logger.info(m)
                  : (m: string) => server.config.logger.warn(m);
                for (const line of result.fixtureCheck.lines) logFn(line);
              }
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
      for (const storageFile of changedStorageFiles) {
        void session.reloadStorageRules(storageFile).then((results) => {
          server.watcher.add([...session.storageRulesFiles()]);
          for (const { bucket, target, file: source, result } of results) {
            const named = storageBucketSuffix(bucket, target);
            if (result.kind === 'reloaded') {
              server.config.logger.info(`  ↻ [pyric] storage rules reloaded${named} (${result.rulesHash})${getVerifyHint()}`);
            } else if (result.kind === 'rejected') {
              server.config.logger.warn(
                `  ⚠ [pyric] storage rules NOT reloaded (last-good stays live): ${result.error.message}${named}`,
              );
            } else if (result.kind === 'removed') {
              server.config.logger.warn(`  ⚠ [pyric] ${formatStorageRulesRemoved(source, result.policy, bucket, target)}`);
            }
          }
        });
      }
    }, 150);
  };

  server.watcher.add([...session.firestoreRulesFiles(), ...databaseFiles, ...session.storageRulesFiles()]);
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
