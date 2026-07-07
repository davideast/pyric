/**
 * Mobile navigation state — which top-level tab is active on phone
 * widths, plus unread dots for the inactive side. Desktop ignores
 * the activeTab field; the unread flags do double duty as "did
 * anything happen behind your back" cues if we ever surface them at
 * larger sizes (we don't right now).
 *
 * Setting the active tab clears its unread flag automatically — the
 * cue exists to draw attention, and the act of switching is the
 * "I see you" signal.
 *
 * Two tabs: App (Preview + the file/rules editor — what used to be
 * the "Workspace" tab) and Agent (right panel with Agent / Files /
 * Terminal / Output / Firebase). The Workspace bottom-tab was
 * retired in the right-panel reshuffle; WorkspacePanel's Preview
 * sub-tab now covers the mobile preview-only surface.
 *
 * `workspaceUnread` + `markWorkspaceUnread` are kept as no-op shims
 * so callers that haven't been migrated yet (mostly unread-tracking
 * hooks) keep type-checking. Their writes are dropped.
 */
import { create } from 'zustand';

export type MobileTab = 'app' | 'agent';

interface MobileNavState {
  activeTab: MobileTab;
  /** @deprecated retained for compatibility; always false. */
  workspaceUnread: boolean;
  appUnread: boolean;
  agentUnread: boolean;
  setActive(tab: MobileTab): void;
  /** @deprecated no-op since the Workspace tab was removed. */
  markWorkspaceUnread(): void;
  markAppUnread(): void;
  markAgentUnread(): void;
}

export const useMobileNavStore = create<MobileNavState>()((set) => ({
  activeTab: 'agent', // first action is typing a prompt
  workspaceUnread: false,
  appUnread: false,
  agentUnread: false,
  setActive: (tab) =>
    set((s) => ({
      activeTab: tab,
      appUnread: tab === 'app' ? false : s.appUnread,
      agentUnread: tab === 'agent' ? false : s.agentUnread,
    })),
  markWorkspaceUnread: () => undefined,
  markAppUnread: () =>
    set((s) => (s.activeTab === 'app' ? s : { appUnread: true })),
  markAgentUnread: () =>
    set((s) => (s.activeTab === 'agent' ? s : { agentUnread: true })),
}));
