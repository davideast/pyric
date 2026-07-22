import path from 'node:path';
import type { ViteDevServer } from 'vite';
import type { SandboxSession } from './sandbox-session.js';

/** Adapt Vite's watcher to the session's last-good Firestore-rules reload operation. */
export function watchViteGenerationRules(input: {
  server: ViteDevServer;
  session: SandboxSession;
}): (() => void) | null {
  const { server, session } = input;
  const rulesFile = session.summary.rules.firestore.sourcePath;
  if (!rulesFile) return null;

  let debounce: ReturnType<typeof setTimeout> | null = null;
  const onRulesChange = (file: string): void => {
    if (path.resolve(file) !== path.resolve(rulesFile)) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      void session.reloadFirestoreRules().then((result) => {
        if (result.kind === 'reloaded') {
          server.config.logger.info(`  ↻ [pyric] rules reloaded (${result.rulesHash})`);
        } else if (result.kind === 'rejected') {
          server.config.logger.warn(
            `  ⚠ [pyric] rules NOT reloaded (last-good stays live): ${result.error.message}`,
          );
        }
      });
    }, 150);
  };

  server.watcher.add(rulesFile);
  server.watcher.on('change', onRulesChange);
  return () => {
    if (debounce) clearTimeout(debounce);
    server.watcher.off('change', onRulesChange);
  };
}
