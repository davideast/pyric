import React from 'react';
import type { User } from 'pyric/auth';

interface TaskHeaderProps {
  currentUser: User | null;
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
  const displayLabel = currentUser
    ? currentUser.displayName || currentUser.email || 'Authenticated User'
    : 'Initializing offline security context...';

  return (
    <header className="flex flex-col gap-3 rounded-2xl bg-zinc-900/60 border border-zinc-800 p-4 shadow-xl w-full">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2.5">
          <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse shrink-0"></span>
          <h1 className="text-lg font-bold text-white tracking-tight">Task Management Workspace</h1>
          <span className="px-2 py-0.5 rounded-md bg-zinc-800 border border-zinc-700 text-[11px] font-mono text-zinc-400">
            In-Page Sandbox
          </span>
        </div>
        <div className="flex items-center gap-2">
          {currentUser ? (
            <>
              <button
                type="button"
                onClick={onOpenSignIn}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-semibold text-xs border border-zinc-700 transition-colors"
              >
                Switch Account
              </button>
              <button
                type="button"
                onClick={onSignOut}
                className="px-3 py-1.5 rounded-lg bg-red-500/15 hover:bg-red-500/25 text-red-400 font-semibold text-xs border border-red-500/30 transition-colors"
              >
                Sign Out
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onOpenSignIn}
              className="px-3.5 py-1.5 rounded-lg bg-white text-zinc-950 hover:bg-zinc-200 font-bold text-xs transition-colors shadow-sm"
            >
              Sign In / Demo Accounts
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-zinc-800 pt-3 text-xs text-zinc-400 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span>Identity:</span>
          {currentUser ? (
            <span className="inline-flex items-center gap-1.5 flex-wrap">
              <span>Signed in as</span>
              <strong className="font-bold text-white">{displayLabel}</strong>
              <code className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 font-mono text-[11px] text-zinc-300">
                {currentUser.uid}
              </code>
            </span>
          ) : (
            <span className="font-semibold text-white truncate">
              Signed out — database modifications will be rejected by Security Rules
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span>Push Alerts:</span>
          {fcmToken ? (
            <span className="inline-flex items-center gap-2 flex-wrap">
              <span className="text-emerald-400 font-bold">Active</span>
              <code className="px-2 py-0.5 rounded bg-zinc-950 border border-zinc-800 font-mono text-[11px] max-w-[220px] truncate inline-block align-bottom">
                {fcmToken}
              </code>
              <button
                type="button"
                onClick={onRevokePush}
                className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-400 font-semibold text-[11px] transition-colors"
              >
                Revoke
              </button>
            </span>
          ) : (
            <>
              <span className="text-zinc-500 italic">Disabled</span>
              <button
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
