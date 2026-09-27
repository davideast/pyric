import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { formatDatabaseRulesRemoved } from './rules.js';
import type { SandboxSession } from './sandbox-session.js';

/**
 * Adapt Vite's watcher to the session's last-good rules reload operations.
 * The Firestore and Realtime Database rules files are watched at the paths
 * the rules load from, whether or not they exist at startup: creating,
 * changing, or deleting either file reloads it. A change to any module file
 * the Firestore rules import reloads, and so does creating one. Files a
 * reload newly imports are watched from then on, whether the reload succeeds
 * or fails.
 */
export function watchViteGenerationRules(input: {
  server: ViteDevServer;
  session: SandboxSession;
}): () => void {
  const { server, session } = input;
  const databaseFile = session.databaseRulesFile();
  const databaseResolved = path.resolve(databaseFile);

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const onRulesChange = (file: string): void => {
    const resolvedFile = path.resolve(file);
    const isFirestoreMatch = session.firestoreRulesFiles().some((file) => path.resolve(file) === resolvedFile);
    const isDatabaseMatch = resolvedFile === databaseResolved;
    const isNeitherMatch = !isFirestoreMatch && !isDatabaseMatch;
    if (isNeitherMatch) {
      return;
    }
    const hasDebounce = debounce !== null;
    if (hasDebounce) {
      clearTimeout(debounce as ReturnType<typeof setTimeout>);
    }
    debounce = setTimeout(() => {
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
      if (isDatabaseMatch) {
        void session.reloadDatabaseRules().then((result) => {
          if (result.kind === 'reloaded') {
            server.config.logger.info(`  ↻ [pyric] rtdb rules reloaded (${result.rulesHash})`);
          } else if (result.kind === 'rejected') {
            server.config.logger.warn(
              `  ⚠ [pyric] rtdb rules NOT reloaded (last-good stays live): ${result.error.message}`,
            );
          } else if (result.kind === 'removed') {
            server.config.logger.warn(`  ⚠ [pyric] ${formatDatabaseRulesRemoved(databaseFile, result.policy)}`);
          }
        });
      }
    }, 150);
  };

  server.watcher.add([...session.firestoreRulesFiles(), databaseFile]);
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
