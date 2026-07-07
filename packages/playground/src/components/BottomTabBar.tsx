/**
 * Mobile bottom tab bar — two tabs: App · Agent. Hidden at `md:` and
 * up. Sits above `env(safe-area-inset-bottom)` so the iOS home
 * indicator doesn't overlap and the bar stays in the visible area
 * when the soft keyboard opens (paired with `100dvh` on `#root`).
 *
 * The App tab shows WorkspacePanel (Preview + file editor); Agent
 * shows the right panel (Agent · Files · Terminal · Output · Firebase).
 * The retired "Workspace" entry was folded into App since
 * WorkspacePanel already has Preview / Rules / Code sub-tabs.
 *
 * Each tab carries an unread dot when its panel has new content the
 * user hasn't seen yet. Tapping clears the dot.
 */
import { useMobileNavStore, type MobileTab } from '~/lib/store/mobile-nav';

interface TabDef {
  id: MobileTab;
  icon: string;
  label: string;
}

const TABS: readonly TabDef[] = [
  { id: 'app', icon: 'smartphone', label: 'App' },
  { id: 'agent', icon: 'chat', label: 'Agent' },
];

export function BottomTabBar() {
  const activeTab = useMobileNavStore((s) => s.activeTab);
  const appUnread = useMobileNavStore((s) => s.appUnread);
  const agentUnread = useMobileNavStore((s) => s.agentUnread);
  const setActive = useMobileNavStore((s) => s.setActive);

  return (
    <nav
      className="md:hidden bg-sidebar-bg border-t border-[#2a2a35] flex shrink-0 z-30"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map((tab) => {
        const active = activeTab === tab.id;
        const unread = tab.id === 'app' ? appUnread : agentUnread;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setActive(tab.id)}
            className={[
              'flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition-colors',
              active ? 'text-soft-white' : 'text-slate-gray hover:text-soft-white/80',
            ].join(' ')}
          >
            <span className="relative">
              <span className="material-symbols-outlined text-[22px]">{tab.icon}</span>
              {unread && !active ? (
                <span className="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-[#a4d4a8] border border-sidebar-bg" />
              ) : null}
            </span>
            <span className="text-[10px] font-medium tracking-wide">{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
