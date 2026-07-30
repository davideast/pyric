import React from 'react';

interface GlobalNavbarProps {
  currentUser: any | null;
  onOpenSignIn: () => void;
  onSignOut: () => void;
  onEnablePush: () => void;
  onRevokePush: () => void;
  fcmToken: string | null;
  onOpenConsole: () => void;
}

export const GlobalNavbar: React.FC<GlobalNavbarProps> = ({
  currentUser,
  onOpenSignIn,
  onSignOut,
  onEnablePush,
  onRevokePush,
  fcmToken,
  onOpenConsole,
}) => {
  const userText = currentUser
    ? `Alice (Owner)`
    : 'Sign In';

  return (
    <header className="w-full border-b border-[var(--app-border)] bg-[var(--app-card)]/90 backdrop-blur sticky top-0 z-40 px-4 sm:px-8 py-3 shadow-sm select-none">
      <div className="max-w-5xl mx-auto flex items-center justify-between flex-wrap gap-4">
        {/* Left: Global App Brand & Logo */}
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg bg-[var(--app-foreground)] text-[var(--app-background)] flex items-center justify-center shadow-sm font-bold shrink-0">
            <svg
              className="w-4 h-4"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm tracking-tight text-[var(--app-foreground)]">
              Pyric Workspace
            </span>
            <span className="px-1.5 py-0.5 rounded bg-[var(--app-muted)] text-[10px] font-medium text-[var(--app-muted-foreground)] border border-[var(--app-border)]">
              In-Page Sandbox
            </span>
          </div>
        </div>

        {/* Right: Traditional Global Action Pills */}
        <div className="flex items-center gap-2 text-xs font-medium ml-auto">
          {/* Account Pill Dropdown/Button */}
          {currentUser ? (
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={onOpenSignIn}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-muted)]/60 hover:bg-[var(--app-muted)] text-[var(--app-foreground)] transition-colors cursor-pointer shadow-sm"
                title="Account Settings"
              >
                <svg
                  className="w-3.5 h-3.5 text-green-500 shrink-0"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span className="font-semibold">{userText}</span>
                <span className="text-[10px] text-[var(--app-muted-foreground)]">▾</span>
              </button>
              <button
                type="button"
                onClick={onSignOut}
                className="px-2 py-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-muted)]/40 hover:bg-red-500/10 text-[var(--app-muted-foreground)] hover:text-red-500 transition-colors cursor-pointer text-[11px]"
                title="Sign Out"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onOpenSignIn}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-foreground)] text-[var(--app-background)] font-semibold transition-opacity hover:opacity-90 cursor-pointer shadow-sm"
            >
              Sign In...
            </button>
          )}

          {/* FCM Push Toggle Pill */}
          {fcmToken ? (
            <button
              type="button"
              onClick={onRevokePush}
              id="pill-push"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-blue-500/40 bg-[var(--app-muted)]/60 text-blue-400 hover:bg-[var(--app-muted)] transition-colors cursor-pointer shadow-sm"
              title="Push notifications active. Click to revoke."
            >
              <svg
                className="w-3.5 h-3.5 shrink-0"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              <span>FCM: Active</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnablePush}
              id="pill-push"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-muted)]/60 hover:bg-[var(--app-muted)] text-[var(--app-muted-foreground)] hover:text-[var(--app-foreground)] transition-colors cursor-pointer shadow-sm"
              title="Enable FCM Push notifications"
            >
              <svg
                className="w-3.5 h-3.5 shrink-0"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              <span>FCM: Off</span>
            </button>
          )}

          {/* Sandbox Inspector Pill */}
          <button
            type="button"
            onClick={onOpenConsole}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-muted)]/60 hover:bg-[var(--app-muted)] text-[var(--app-foreground)] font-semibold transition-colors cursor-pointer shadow-sm"
            title="Inspect Pyric Sandbox rules and drivers"
          >
            <span className="text-amber-500">⚡</span>
            <span>Sandbox</span>
          </button>
        </div>
      </div>
    </header>
  );
};
