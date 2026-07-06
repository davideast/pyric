import { ActivityTab } from './ActivityTab';
import { ContextTab } from './ContextTab';
import type { ContextWindowSnapshot } from '~/lib/agent/context-window';
import { useNavStore } from '~/lib/store/nav';

export type AgentSubTab = 'chat' | 'context';

interface AgentPanelProps {
  activeSubTab: AgentSubTab;
  onSubTabChange: (tab: AgentSubTab) => void;
  contextWindow: ContextWindowSnapshot;
  onCompactContext: () => void;
  onSendPrompt?: (prompt: string) => void;
  sendBusy?: boolean;
  onAfterSend?: () => void;
  onApproveEnhancement?: (id: string, enhancedText: string) => void;
  onEditEnhancement?: (id: string, enhancedText: string) => void;
  onDiscardEnhancement?: (id: string) => void;
  onRetryEnhancement?: (id: string, rawInput: string) => void;
}

const TABS: Array<{ id: AgentSubTab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'context', label: 'Context' },
];

export function AgentPanel({
  activeSubTab,
  onSubTabChange,
  contextWindow,
  onCompactContext,
  onSendPrompt,
  sendBusy,
  onAfterSend,
  onApproveEnhancement,
  onEditEnhancement,
  onDiscardEnhancement,
  onRetryEnhancement,
}: AgentPanelProps) {
  const requestToolDrill = useNavStore((s) => s.requestToolDrill);

  const handleOpenTimelineTool = (messageId: string, callId: string) => {
    requestToolDrill(messageId, callId);
    onSubTabChange('chat');
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-10 border-b border-[#2a2a35] px-4 flex items-end gap-1 shrink-0">
        {TABS.map((tab) => {
          const active = tab.id === activeSubTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onSubTabChange(tab.id)}
              className={[
                'px-3 py-2 text-[12px] font-semibold font-display border-b-2 -mb-px transition-colors',
                active
                  ? 'text-soft-white border-soft-white'
                  : 'text-slate-gray border-transparent hover:text-soft-white/80',
              ].join(' ')}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <AgentSubTabPane active={activeSubTab === 'chat'}>
        <ActivityTab
          onSendPrompt={onSendPrompt}
          sendBusy={sendBusy}
          onAfterSend={onAfterSend}
          onApproveEnhancement={onApproveEnhancement}
          onEditEnhancement={onEditEnhancement}
          onDiscardEnhancement={onDiscardEnhancement}
          onRetryEnhancement={onRetryEnhancement}
        />
      </AgentSubTabPane>
      <AgentSubTabPane active={activeSubTab === 'context'}>
        <ContextTab
          snapshot={contextWindow}
          onCompactNow={onCompactContext}
          onOpenTool={handleOpenTimelineTool}
        />
      </AgentSubTabPane>
    </div>
  );
}

function AgentSubTabPane({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) {
  const inertProp = active ? {} : { inert: true };
  return (
    <div
      {...inertProp}
      aria-hidden={!active}
      className={active ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}
    >
      {children}
    </div>
  );
}
