/**
 * Right-panel "Firebase" tab. Consolidates everything that talks to
 * the user's (or the in-browser sandbox's) Firebase backend under
 * four sub-tabs:
 *
 *   - Sandbox     — per-session shared/isolated runtime mode.
 *   - Data        — Firestore collection/document browser + editor (admin mode)
 *   - RTDB        — Realtime Database tree browser + editor (admin mode)
 *   - Auth        — sandbox identity store (emulator-style user admin)
 *   - Traffic     — request log + denial inspector.
 *   - Seed        — host-owned quick data-seed surface (SF-S2): the
 *                   data analog of Auth, session-scoped + ephemeral.
 *   - Ideas       — Firebase data/rules prompt starters.
 *   - Suggestions — agent-surfaced analysis suggestions, with one-click
 *                   prompt sends.
 *
 * Replaces the old `AgentFirestoreTab` (Data + Traffic only) and the
 * sibling `Suggestions` top-level tab — pulling them
 * into one Firebase namespace gets the right panel down to five
 * top-level tabs (Agent · Files · Terminal · Output · Firebase).
 */
import { AuthTab } from './AuthTab';
import { CodeSubTabs } from './CodeSubTabs';
import { DataSeedTab } from './DataSeedTab';
import { IdeasTab } from './IdeasTab';
import { FirestoreTab } from './FirestoreTab';
import { FirestoreTabBoundary } from './FirestoreTabBoundary';
import { RtdbTab } from './RtdbTab';
import { SuggestionsTab } from './SuggestionsTab';
import { TrafficTab } from './TrafficTab';
import type { AgentPromptProfile } from '~/lib/skills/registry';
import type { PlaygroundSandboxMode } from '~/lib/studio-embed';
import { useRuntimeStore } from '~/lib/store/runtime';
import { useWorkspaceStore } from '~/lib/store/workspace';
import {
  firebaseSubTabsForProfile,
  type FirebaseWorkbenchSubTab,
} from './workbench-tabs';

export type FirebaseSubTab = FirebaseWorkbenchSubTab;

export interface FirebaseTabProps {
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
  sandboxMode: PlaygroundSandboxMode;
  sandboxModeDisabled?: boolean;
  onSandboxModeChange: (mode: PlaygroundSandboxMode) => void;
  promptProfile?: AgentPromptProfile;
}

export function FirebaseTab({
  onSendPrompt,
  sendBusy,
  onAfterSend,
  subTab,
  onSubTabChange,
  onNavigateAgent,
  sandboxMode,
  sandboxModeDisabled,
  onSandboxModeChange,
  promptProfile = 'firebase',
}: FirebaseTabProps) {
  const subTabs = firebaseSubTabsForProfile(promptProfile);
  const activeSubTab = subTabs.some((tab) => tab.id === subTab) ? subTab : 'sandbox';

  return (
    <div className="flex flex-col h-full min-w-0">
      <CodeSubTabs
        tabs={subTabs}
        activeTab={activeSubTab}
        onTabChange={(id) => onSubTabChange(id as FirebaseSubTab)}
      />
      <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
        {activeSubTab === 'ideas' ? (
          <IdeasTab
            {...(onSendPrompt ? { onSendPrompt } : {})}
            {...(sendBusy !== undefined ? { sendBusy } : {})}
            {...(onAfterSend ? { onAfterSend } : {})}
          />
        ) : null}
        {activeSubTab === 'data' ? (
          <FirestoreTabBoundary>
            <FirestoreTab />
          </FirestoreTabBoundary>
        ) : null}
        {activeSubTab === 'rtdb' ? <RtdbTab /> : null}
        {activeSubTab === 'auth' ? <AuthTab /> : null}
        {activeSubTab === 'seed' ? <DataSeedTab /> : null}
        {activeSubTab === 'traffic' ? (
          <TrafficTab
            {...(onSendPrompt ? { onSendPrompt } : {})}
            {...(sendBusy !== undefined ? { sendBusy } : {})}
            {...(onAfterSend ? { onAfterSend } : {})}
          />
        ) : null}
        {activeSubTab === 'sandbox' ? (
          <SandboxTab
            mode={sandboxMode}
            disabled={sandboxModeDisabled}
            onChange={onSandboxModeChange}
          />
        ) : null}
        {activeSubTab === 'suggestions' ? (
          <SuggestionsTab
            {...(onSendPrompt ? { onSendPrompt } : {})}
            {...(sendBusy !== undefined ? { sendBusy } : {})}
            {...(onAfterSend ? { onAfterSend } : {})}
            {...(onNavigateAgent ? { onNavigateActivity: onNavigateAgent } : {})}
            onNavigateFirestoreTraffic={() => onSubTabChange('traffic')}
          />
        ) : null}
      </div>
    </div>
  );
}

function SandboxTab({
  mode,
  disabled,
  onChange,
}: {
  mode: PlaygroundSandboxMode;
  disabled?: boolean;
  onChange: (mode: PlaygroundSandboxMode) => void;
}) {
  const trafficCount = useRuntimeStore((s) => s.traffic.length);
  const denialCount = useRuntimeStore((s) => s.liveDenials.length);
  const lastDeploy = useRuntimeStore((s) => s.lastDeploy);
  const rules = useWorkspaceStore((s) => s.rules);
  const databaseRules = useWorkspaceStore((s) => s.databaseRules);
  const firestoreRulesState = rules.trim().length > 0
    ? lastDeploy?.ok === false
      ? 'needs attention'
      : 'present'
    : 'empty';
  const databaseRulesState = databaseRules.trim().length > 0 ? 'present' : 'empty';
  return (
    <section className="flex-1 overflow-y-auto custom-scrollbar p-4 text-soft-white">
      <div className="grid gap-4 max-w-2xl">
        <div className="grid gap-1">
          <p className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">
            Playground session
          </p>
          <h2 className="text-[18px] font-semibold font-display">Sandbox mode</h2>
          <p className="text-[12px] leading-relaxed text-slate-gray">
            This setting belongs to the current Playground session. Shared mode uses the
            same Studio sandbox for preview, data, auth, rules, and traffic. Isolated mode
            keeps this session on its own local runtime.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <SandboxStat label="Firestore rules" value={firestoreRulesState} />
          <SandboxStat label="RTDB rules" value={databaseRulesState} />
          <SandboxStat label="Traffic events" value={String(trafficCount)} />
          <SandboxStat label="Live denials" value={String(denialCount)} />
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <SandboxChoice
            mode="shared"
            active={mode === 'shared'}
            disabled={disabled}
            title="Shared sandbox"
            description="Preview changes and Firebase panel changes use the same Studio sandbox."
            onChange={onChange}
          />
          <SandboxChoice
            mode="isolated"
            active={mode === 'isolated'}
            disabled={disabled}
            title="Isolated session"
            description="Keep this Playground session separate from Studio's shared sandbox."
            onChange={onChange}
          />
        </div>

        {disabled ? (
          <p className="rounded border border-[#3a3225] bg-[#2a2418]/50 px-3 py-2 text-[12px] text-[#e6c79c]">
            This session is read-only in this tab. Take over the session before changing
            sandbox mode.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function SandboxStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[#2a2a35] bg-[#17171d] p-3">
      <p className="font-mono text-[10px] uppercase tracking-wide text-slate-gray">
        {label}
      </p>
      <p className="mt-1 text-[14px] font-semibold text-soft-white">{value}</p>
    </div>
  );
}

function SandboxChoice({
  mode,
  active,
  disabled,
  title,
  description,
  onChange,
}: {
  mode: PlaygroundSandboxMode;
  active: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  onChange: (mode: PlaygroundSandboxMode) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled || active}
      aria-pressed={active}
      onClick={() => onChange(mode)}
      className={[
        'grid min-h-[112px] gap-2 rounded border p-3 text-left transition-colors',
        active
          ? 'border-primary/50 bg-primary/10 text-soft-white'
          : 'border-[#2a2a35] bg-[#17171d] text-slate-gray hover:border-[#3a3a48] hover:text-soft-white',
        disabled ? 'cursor-not-allowed opacity-60' : '',
      ].join(' ')}
    >
      <span className="flex items-center gap-2 text-[13px] font-semibold">
        <span
          className={active ? 'text-primary' : 'text-slate-gray'}
          aria-hidden
        >
          ●
        </span>
        {title}
      </span>
      <span className="text-[12px] leading-relaxed text-slate-gray">{description}</span>
      <span className="font-mono text-[10px] uppercase tracking-wide text-slate-gray">
        {active ? 'Current mode' : 'Switch mode'}
      </span>
    </button>
  );
}
