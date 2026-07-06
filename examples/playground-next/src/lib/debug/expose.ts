/**
 * Dev-only `window` exposure for the Playwright debug driver
 * (`scripts/playground-debug.ts`). Lets the driver create sessions,
 * seed workspace state, and inspect stores without scraping the DOM.
 *
 * Gated on `import.meta.env.DEV` so the production build doesn't ship
 * a global escape hatch into the runtime.
 *
 * Shape stays narrow on purpose — only what an external test needs:
 *
 *   window.__pyric.sessions.saveSession(userId, input)
 *   window.__pyric.sessions.getCurrentUserId()
 *   window.__pyric.workspace.setRules(...)
 *   window.__pyric.workspace.setAppSource(...)
 *   window.__pyric.chat.snapshot()    // current messages array
 *
 * Import this once from the playground entry; it self-installs on
 * load.
 */

import * as sessions from '~/lib/sessions';
import { useChatStore } from '~/lib/store/chat';
import { useWorkspaceStore } from '~/lib/store/workspace';

declare global {
  interface Window {
    __pyric?: {
      sessions: typeof sessions;
      workspace: {
        setRules: (s: string) => void;
        setAppSource: (s: string) => void;
        snapshot: () => { rules: string; appSource: string };
      };
      chat: {
        snapshot: () => ReturnType<typeof useChatStore.getState>['messages'];
        clear: () => void;
      };
    };
  }
}

const isDev = (() => {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
})();

if (isDev && typeof window !== 'undefined') {
  window.__pyric = {
    sessions,
    workspace: {
      setRules: (s) => useWorkspaceStore.getState().setRules(s),
      setAppSource: (s) => useWorkspaceStore.getState().setAppSource(s),
      snapshot: () => {
        const ws = useWorkspaceStore.getState();
        return { rules: ws.rules, appSource: ws.appSource };
      },
    },
    chat: {
      snapshot: () => useChatStore.getState().messages,
      clear: () => useChatStore.getState().clear(),
    },
  };
}
