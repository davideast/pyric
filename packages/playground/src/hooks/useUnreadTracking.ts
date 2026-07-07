/**
 * Detect changes that should light up the inactive mobile tab's
 * unread dot. Mount once at the page root; subscribes to both the
 * workspace and chat stores via Zustand selectors and ticks the
 * mobile-nav store when changes happen while the other tab is active.
 *
 * Initial mount is skipped — the dot should only appear in response
 * to actual user/agent activity, not the first paint.
 */
import { useEffect, useRef } from 'react';
import { useChatStore } from '~/lib/store/chat';
import { useMobileNavStore } from '~/lib/store/mobile-nav';
import { useRuntimeStore } from '~/lib/store/runtime';
import { useWorkspaceStore } from '~/lib/store/workspace';

export function useUnreadTracking(): void {
  const rules = useWorkspaceStore((s) => s.rules);
  const appSource = useWorkspaceStore((s) => s.appSource);
  const lastRun = useRuntimeStore((s) => s.lastRun);
  const messages = useChatStore((s) => s.messages);

  const firstWorkspace = useRef(true);
  useEffect(() => {
    if (firstWorkspace.current) {
      firstWorkspace.current = false;
      return;
    }
    useMobileNavStore.getState().markWorkspaceUnread();
  }, [rules, appSource, lastRun]);

  const firstAgent = useRef(true);
  const lastCount = useRef(messages.length);
  useEffect(() => {
    if (firstAgent.current) {
      firstAgent.current = false;
      lastCount.current = messages.length;
      return;
    }
    if (messages.length > lastCount.current) {
      useMobileNavStore.getState().markAgentUnread();
    }
    lastCount.current = messages.length;
  }, [messages]);
}
