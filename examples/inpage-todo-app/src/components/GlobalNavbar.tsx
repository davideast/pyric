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
  let userText = 'Sign In';
  if (currentUser) {
    if (currentUser.displayName) {
      if (currentUser.displayName.includes('Alice')) userText = 'Alice (Owner)';
      else if (currentUser.displayName.includes('Bob')) userText = 'Bob';
      else userText = currentUser.displayName;
    } else if (currentUser.email) {
      const name = currentUser.email.split('@')[0];
      userText = name.charAt(0).toUpperCase() + name.slice(1);
    } else {
      userText = 'Guest';
    }
  }

  return (
    <header className="w-full border-b border-[var(--app-border)] bg-[var(--app-card)]/90 backdrop-blur sticky top-0 z-40 px-4 sm:px-8 py-2.5 shadow-sm select-none">
      <div className="max-w-2xl mx-auto flex items-center justify-between flex-wrap gap-3">
        {/* Left: Global App Brand & Logo */}
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-[var(--app-foreground)] text-[var(--app-background)] flex items-center justify-center shadow-sm font-bold shrink-0">
            <svg
              className="w-3.5 h-3.5"
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
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-xs sm:text-sm tracking-tight text-[var(--app-foreground)]">
              Pyric Workspace
            </span>
            <span className="hidden sm:inline-block px-1.5 py-0.5 rounded bg-[var(--app-muted)] text-[10px] font-semibold text-[var(--app-muted-foreground)] border border-[var(--app-border)]">
              In-Page Sandbox
            </span>
          </div>
        </div>

        {/* Right: Compact Aligned Global Action Pills */}
        <div className="flex items-center gap-1.5 text-xs font-medium ml-auto">
          {/* Account Pill Dropdown/Button */}
          {currentUser ? (
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={onOpenSignIn}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-muted)]/60 hover:bg-[var(--app-muted)] text-[var(--app-foreground)] transition-colors cursor-pointer shadow-sm text-xs"
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
                <span className="font-semibold text-xs">{userText}</span>
                <span className="text-[10px] text-[var(--app-muted-foreground)]">▾</span>
              </button>
              <button
                type="button"
                onClick={onSignOut}
                className="px-2 py-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-muted)]/40 hover:bg-red-500/10 text-[var(--app-muted-foreground)] hover:text-red-500 transition-colors cursor-pointer text-[10px] font-medium"
                title="Sign Out"
              >
                Sign Out
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onOpenSignIn}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-foreground)] text-[var(--app-background)] font-semibold transition-opacity hover:opacity-90 cursor-pointer shadow-sm text-xs"
            >
              Sign In
            </button>
          )}

          {/* FCM Push Toggle Pill */}
          {fcmToken ? (
            <button
              type="button"
              onClick={onRevokePush}
              id="pill-push"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-blue-500/40 bg-[var(--app-muted)]/60 text-blue-400 hover:bg-[var(--app-muted)] transition-colors cursor-pointer shadow-sm text-xs"
              title="FCM Push: Active (Click to revoke)"
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
              <span className="hidden sm:inline text-xs">FCM</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onEnablePush}
              id="pill-push"
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-muted)]/60 hover:bg-[var(--app-muted)] text-[var(--app-muted-foreground)] hover:text-[var(--app-foreground)] transition-colors cursor-pointer shadow-sm text-xs"
              title="FCM Push: Off (Click to enable)"
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
              <span className="hidden sm:inline text-xs">Off</span>
            </button>
          )}

          {/* Sandbox Inspector Pill */}
          <button
            type="button"
            onClick={onOpenConsole}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-muted)]/60 hover:bg-[var(--app-muted)] text-[var(--app-foreground)] font-semibold transition-colors cursor-pointer shadow-sm text-xs"
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
