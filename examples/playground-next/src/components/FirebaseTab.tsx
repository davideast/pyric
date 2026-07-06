/**
 * Right-panel "Firebase" tab. Consolidates everything that talks to
 * the user's (or the in-browser sandbox's) Firebase backend under
 * four sub-tabs:
 *
 *   - Data        — collection/document browser + editor (admin mode)
 *   - Auth        — sandbox identity store (emulator-style user admin)
 *   - Seed        — host-owned quick data-seed surface (SF-S2): the
 *                   data analog of Auth, session-scoped + ephemeral.
 *   - Traffic     — request log + denial inspector. Carries the
 *                   unread-denial count badge.
 *   - Suggestions — agent-surfaced analysis suggestions, with one-click
 *                   prompt sends.
 *   - Deploy      — Firebase Hosting / Rules / Indexes deploy hooks.
 *
 * Replaces the old `AgentFirestoreTab` (Data + Traffic only) and the
 * sibling `Suggestions` and `Deploy` top-level tabs — pulling them
 * into one Firebase namespace gets the right panel down to five
 * top-level tabs (Agent · Files · Terminal · Output · Firebase).
 */
import { AuthTab } from './AuthTab';
import { CodeSubTabs, type SubTab } from './CodeSubTabs';
import { DataSeedTab } from './DataSeedTab';
import { DeployTab } from './DeployTab';
import { IdeasTab } from './IdeasTab';
import { FirestoreTab } from './FirestoreTab';
import { FirestoreTabBoundary } from './FirestoreTabBoundary';
import { SuggestionsTab } from './SuggestionsTab';
import { TrafficTab } from './TrafficTab';
import { useRuntimeStore } from '~/lib/store/runtime';
import type { ContextWindowSnapshot } from '~/lib/agent/context-window';

export type FirebaseSubTab =
  | 'ideas'
  | 'data'
  | 'auth'
  | 'seed'
  | 'traffic'
  | 'suggestions'
  | 'deploy';

interface Props {
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
  /** Lifted so the AppPreview denial banner can land directly on
   *  `traffic` even when the component is already mounted on `data`. */
  subTab: FirebaseSubTab;
  onSubTabChange: (s: FirebaseSubTab) => void;
  /** Navigate back to the Agent (chat) tab — used by SuggestionsTab
   *  when the user invokes a one-click prompt. */
  onNavigateAgent?: () => void;
  sessionId?: string | null;
  contextWindow?: ContextWindowSnapshot;
}

export function FirebaseTab({
  onSendPrompt,
  sendBusy,
  onAfterSend,
  subTab,
  onSubTabChange,
  onNavigateAgent,
  sessionId,
  contextWindow,
}: Props) {
  const liveDenials = useRuntimeStore((s) => s.liveDenials);
  const unread = liveDenials.filter((d) => !d.acknowledged).length;

  const subTabs: readonly SubTab[] = [
    { id: 'ideas', label: 'Ideas' },
    { id: 'data', label: 'Data' },
    { id: 'auth', label: 'Auth' },
    { id: 'seed', label: 'Seed' },
    { id: 'traffic', label: unread > 0 ? `Traffic · ${unread}` : 'Traffic' },
    { id: 'suggestions', label: 'Suggestions' },
    { id: 'deploy', label: 'Deploy' },
  ];

  return (
    <div className="flex flex-col h-full min-w-0">
      <CodeSubTabs
        tabs={subTabs}
        activeTab={subTab}
        onTabChange={(id) => onSubTabChange(id as FirebaseSubTab)}
      />
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {subTab === 'ideas' ? (
          <IdeasTab
            {...(onSendPrompt ? { onSendPrompt } : {})}
            {...(sendBusy !== undefined ? { sendBusy } : {})}
            {...(onAfterSend ? { onAfterSend } : {})}
          />
        ) : null}
        {subTab === 'data' ? (
          <FirestoreTabBoundary>
            <FirestoreTab />
          </FirestoreTabBoundary>
        ) : null}
        {subTab === 'auth' ? <AuthTab /> : null}
        {subTab === 'seed' ? <DataSeedTab /> : null}
        {subTab === 'traffic' ? (
          <TrafficTab
            {...(onSendPrompt ? { onSendPrompt } : {})}
            {...(sendBusy !== undefined ? { sendBusy } : {})}
            {...(onAfterSend ? { onAfterSend } : {})}
          />
        ) : null}
        {subTab === 'suggestions' ? (
          <SuggestionsTab
            {...(onSendPrompt ? { onSendPrompt } : {})}
            {...(sendBusy !== undefined ? { sendBusy } : {})}
            {...(onAfterSend ? { onAfterSend } : {})}
            {...(onNavigateAgent ? { onNavigateActivity: onNavigateAgent } : {})}
            onNavigateFirestoreTraffic={() => onSubTabChange('traffic')}
          />
        ) : null}
        {subTab === 'deploy' ? (
          <DeployTab sessionId={sessionId} contextWindow={contextWindow} />
        ) : null}
      </div>
    </div>
  );
}
