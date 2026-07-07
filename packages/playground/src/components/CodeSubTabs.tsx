/**
 * Segmented-control style sub-tabs used inside the Code panel. Subtler
 * than `PanelTabs` (no underline, no border) so it reads as secondary
 * navigation rather than competing with the primary Rules/Code strip.
 */
export interface SubTab {
  id: string;
  label: string;
}

export interface CodeSubTabsProps {
  tabs: readonly SubTab[];
  activeTab: string;
  onTabChange: (id: string) => void;
}

export function CodeSubTabs({ tabs, activeTab, onTabChange }: CodeSubTabsProps) {
  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[#2a2a35] shrink-0 bg-content-bg">
      {tabs.map((tab) => {
        const active = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onTabChange(tab.id)}
            className={[
              'px-2.5 py-1 rounded text-[11px] font-medium font-display transition-colors',
              active
                ? 'bg-[#2a2a35] text-soft-white'
                : 'text-slate-gray hover:text-soft-white hover:bg-[#2a2a35]/40',
            ].join(' ')}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
