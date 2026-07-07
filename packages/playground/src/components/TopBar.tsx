/**
 * Top bar — brand, title, action icons, state indicator. Adapted from
 * jules.ink's `TopBar` with playground-specific actions (key,
 * settings, account) replacing the print/transport controls.
 *
 * There is deliberately NO save icon: sessions autosave ambiently
 * (see `AutosaveStatus`, which the playground page renders into the
 * `children` slot), and the account icon opens the sign-in modal
 * without pretending to be a save action.
 */
import type { SessionMeta } from '~/lib/sessions';
export type SessionState = 'idle' | 'streaming' | 'complete' | 'failed';

export interface TopBarProps {
  title?: string;
  sessionState?: SessionState;
  githubRepo?: SessionMeta['githubRepo'] | null;
  onOpenKeys?: () => void;
  onOpenSettings?: () => void;
  /** Opens the account/sign-in modal (`AuthModal`). Labeled as
   *  account — sign-in is for deploys, not a prerequisite to save. */
  onOpenAccount?: () => void;
  homeHref?: string;
  children?: React.ReactNode;
}

function Brand({ homeHref = '/' }: { homeHref?: string }) {
  return (
    <a
      href={homeHref}
      title="Home"
      aria-label="Pyric home"
      className="flex items-center gap-2.5 text-soft-white/70 hover:text-soft-white transition-colors rounded -ml-1 px-1"
    >
      <span
        className="material-symbols-outlined text-[20px]"
        aria-hidden
      >
        terminal
      </span>
      <span className="text-[13px] font-mono tracking-[-0.02em]">
        pyric
      </span>
    </a>
  );
}

export function TopBar({
  title,
  sessionState,
  githubRepo,
  onOpenKeys,
  onOpenSettings,
  onOpenAccount,
  homeHref,
  children,
}: TopBarProps) {
  return (
    <header
      className="bg-sidebar-bg border-b border-[#2a2a35] flex items-center justify-between px-4 shrink-0 z-30"
      // Pad the top by the safe-area inset on mobile so the brand row
      // sits below the iOS notch / status bar and there's room for the
      // browser's pull-to-refresh gesture above the chrome. Total bar
      // height is the inset + the 52px content row; on desktop the
      // inset is 0 so the bar collapses back to 52px.
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        minHeight: 'calc(52px + env(safe-area-inset-top))',
      }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Brand homeHref={homeHref} />
        {/* Page title is redundant with the Brand on mobile — there's
            only one page. Show it from `sm:` and up. */}
        {title ? (
          <>
            <span className="hidden sm:inline-block h-4 w-px bg-[#2a2a32] shrink-0" />
            <span className="hidden sm:inline text-soft-white text-[13px] font-medium truncate">
              {title}
            </span>
          </>
        ) : null}
      </div>

      <div className="flex items-center gap-4 shrink-0">
        {githubRepo ? (
          <a
            href={githubRepo.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            title={githubRepo.fullName}
            className="hidden sm:inline-flex items-center gap-1 rounded-full border border-[#2a2a35] px-2 py-0.5 text-[10px] font-mono text-[#a4c4f0] hover:border-[#3a3a48] hover:text-soft-white transition-colors max-w-[200px] truncate"
          >
            <span className="material-symbols-outlined text-[12px] shrink-0">link</span>
            {githubRepo.fullName}
          </a>
        ) : null}
        {children}

        {/* Streaming has its own per-message indicator on the active
            timeline row — surfacing it here too is redundant noise.
            Only `failed` warrants a TopBar pill, since the timeline
            entry that errored may have scrolled off-screen. */}
        {sessionState === 'failed' ? (
          <span className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[14px] text-red-500">close</span>
            <span className="text-slate-gray text-xs font-medium">Failed</span>
          </span>
        ) : null}

        <div className="flex items-center gap-1">
          {onOpenKeys ? (
            <button
              type="button"
              onClick={onOpenKeys}
              title="API keys"
              className="inline-flex items-center justify-center text-slate-gray hover:text-soft-white transition-colors p-1.5 rounded"
            >
              <span className="material-symbols-outlined text-[18px]">key</span>
            </button>
          ) : null}
          {onOpenSettings ? (
            <button
              type="button"
              onClick={onOpenSettings}
              title="Settings"
              className="inline-flex items-center justify-center text-slate-gray hover:text-soft-white transition-colors p-1.5 rounded"
            >
              <span className="material-symbols-outlined text-[18px]">settings</span>
            </button>
          ) : null}
          {onOpenAccount ? (
            <button
              type="button"
              onClick={onOpenAccount}
              title="Account — sign in for deploys"
              className="inline-flex items-center justify-center text-slate-gray hover:text-soft-white transition-colors p-1.5 rounded"
            >
              <span className="material-symbols-outlined text-[18px]">account_circle</span>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
