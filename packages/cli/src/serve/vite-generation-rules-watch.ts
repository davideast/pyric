import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { SandboxSession } from './sandbox-session.js';

/** Adapt Vite's watcher to the session's last-good Firestore-rules reload operation. */
export function watchViteGenerationRules(input: {
  server: ViteDevServer;
  session: SandboxSession;
}): (() => void) | null {
  const { server, session } = input;
  const firestoreFile = session.summary.rules.firestore.sourcePath;
  const databaseFile = session.summary.rules.database.sourcePath;
  const hasFirestoreFile = firestoreFile !== null;
  const hasDatabaseFile = databaseFile !== null;
  const hasNeitherFile = !hasFirestoreFile && !hasDatabaseFile;
  if (hasNeitherFile) {
    return null;
  }

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const onRulesChange = (file: string): void => {
    const resolvedFile = path.resolve(file);
    let isFirestoreMatch = false;
    if (hasFirestoreFile) {
      const firestoreResolved = path.resolve(firestoreFile);
      isFirestoreMatch = resolvedFile === firestoreResolved;
    }
    let isDatabaseMatch = false;
    if (hasDatabaseFile) {
      const databaseResolved = path.resolve(databaseFile);
      isDatabaseMatch = resolvedFile === databaseResolved;
    }
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
          const isReloaded = result.kind === 'reloaded';
          if (isReloaded) {
            server.config.logger.info(`  ↻ [pyric] rtdb rules reloaded (${result.rulesHash})`);
          } else {
            const isRejected = result.kind === 'rejected';
            if (isRejected) {
              server.config.logger.warn(
                `  ⚠ [pyric] rtdb rules NOT reloaded (last-good stays live): ${result.error.message}`,
              );
            }
          }
        });
      }
    }, 150);
  };

  if (hasFirestoreFile) {
    server.watcher.add(firestoreFile);
  }
  if (hasDatabaseFile) {
    server.watcher.add(databaseFile);
  }
  server.watcher.on('change', onRulesChange);
  return () => {
    const hasDebounce = debounce !== null;
    if (hasDebounce) {
      clearTimeout(debounce as ReturnType<typeof setTimeout>);
    }
    server.watcher.off('change', onRulesChange);
  };
}
