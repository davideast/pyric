/**
 * Tab strip used in the right panel. Pure presentational — state
 * lives in the parent. Ported from jules.ink.
 */
export interface Tab {
  id: string;
  label: string;
  /** Optional badge — number or string rendered as a small pill next
   *  to the label. Used for "N unread" / "N denials" hints. */
  badge?: { text: string; tone?: 'neutral' | 'warn' | 'error' };
}

export interface PanelTabsProps {
  tabs: readonly Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

export function PanelTabs({ tabs, activeTab, onTabChange }: PanelTabsProps) {
  return (
    <div className="flex border-b border-[#2a2a35] px-4 shrink-0">
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={[
              'px-3 py-2.5 text-[13px] font-medium font-display transition-colors',
              'border-b-2 -mb-px inline-flex items-center gap-1.5',
              active
                ? 'text-soft-white border-soft-white'
                : 'text-slate-gray border-transparent hover:text-soft-white/80',
            ].join(' ')}
          >
            <span>{tab.label}</span>
            {tab.badge ? (
              <span
                className={[
                  'inline-flex items-center justify-center min-w-[16px] h-[16px] px-1',
                  'rounded-full text-[9px] font-mono font-bold',
                  tab.badge.tone === 'error'
                    ? 'bg-[#3a2a2a] text-[#f0a0a0]'
                    : tab.badge.tone === 'warn'
                      ? 'bg-[#3a3225] text-[#e6c79c]'
                      : 'bg-[#2a2a35] text-slate-gray',
                ].join(' ')}
              >
                {tab.badge.text}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
