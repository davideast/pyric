import React from 'react';

interface TaskHeaderProps {
  currentUser: any | null;
  onOpenSignIn: () => void;
  onSignOut: () => void;
  onEnablePush: () => void;
  onRevokePush: () => void;
  fcmToken: string | null;
}

export const TaskHeader: React.FC<TaskHeaderProps> = ({
  currentUser,
  onOpenSignIn,
  onSignOut,
  onEnablePush,
  onRevokePush,
  fcmToken,
}) => {
  return (
    <header className="flex flex-col gap-3 rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 shadow-xl select-text cursor-default">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <h1 className="text-lg font-bold text-white tracking-tight">
            Task Management Workspace
          </h1>
          <span className="px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] font-mono text-zinc-400">
            In-Page Sandbox
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!currentUser ? (
            <button
              id="signin-btn"
              type="button"
              onClick={onOpenSignIn}
              className="px-3.5 py-1.5 rounded-lg bg-white text-zinc-950 hover:bg-zinc-200 font-bold text-xs transition-colors shadow-sm"
            >
              Sign In / Demo Accounts
            </button>
          ) : null}
          {currentUser ? (
            <>
              <button
                id="switch-user-btn"
                type="button"
                onClick={onOpenSignIn}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold text-xs border border-zinc-700 transition-colors"
              >
                Switch Account
              </button>
              <button
                id="signout-btn"
                type="button"
                onClick={onSignOut}
                className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-400 font-semibold text-xs border border-red-500/30 transition-colors"
              >
                Sign Out
              </button>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-zinc-800 pt-3 text-xs text-zinc-400 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span>Identity:</span>
          <span id="auth-status-text" className="font-semibold text-white truncate">
            {currentUser ? (
              <span className="inline-flex items-center gap-1.5 flex-wrap">
                <span>Signed in as</span>
                <span className="font-bold text-white">
                  {currentUser.displayName || currentUser.email || 'Authenticated User'}
                </span>
                <code className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 font-mono text-[11px] text-zinc-300">
                  {currentUser.uid}
                </code>
              </span>
            ) : (
              'Initializing offline security context...'
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span>Push Alerts:</span>
          {fcmToken ? (
            <>
              <span className="text-emerald-400 italic font-medium">
                Active ({fcmToken.slice(0, 10)}...)
              </span>
              <button
                id="fcm-disable-btn"
                type="button"
                onClick={onRevokePush}
                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 font-semibold text-[11px] transition-colors"
              >
                Revoke
              </button>
            </>
          ) : (
            <>
              <span id="fcm-status-text" className="text-zinc-500 italic">
                Disabled
              </span>
              <button
                id="fcm-enable-btn"
                type="button"
                onClick={onEnablePush}
                className="px-2 py-0.5 rounded bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/40 text-blue-300 font-semibold text-[11px] transition-colors"
              >
                Enable
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
};
