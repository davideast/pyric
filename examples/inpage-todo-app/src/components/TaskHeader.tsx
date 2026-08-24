import React from 'react';
import type { TaskItem } from '../services/firebase-service';

interface TaskHeaderProps {
  tasks: TaskItem[];
  currentUser: any | null;
  onOpenSignIn: () => void;
  onSignOut: () => void;
  onEnablePush: () => void;
  onRevokePush: () => void;
  fcmToken: string | null;
  onOpenConsole: () => void;
}

export const TaskHeader: React.FC<TaskHeaderProps> = ({
  tasks,
  currentUser,
  onOpenSignIn,
  onSignOut,
  onEnablePush,
  onRevokePush,
  fcmToken,
  onOpenConsole,
}) => {
  const totalCount = tasks.length;
  const activeCount = tasks.filter((t) => !t.completed).length;
  const completedCount = totalCount - activeCount;
  const percent =
    totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;

  const authStatusText = currentUser
    ? `Signed in as ${currentUser.displayName || currentUser.email || currentUser.uid}`
    : 'Checking auth state...';

  return (
    <div className="bg-[var(--app-card)] text-[var(--app-foreground)] border border-[var(--app-border)] rounded-xl p-6 shadow-sm flex flex-col gap-5 select-text cursor-default">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-[var(--app-foreground)] text-[var(--app-background)] flex items-center justify-center shadow-sm font-bold shrink-0">
            <svg
              className="w-5 h-5"
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
          <div className="flex flex-col gap-1">
            <h1 className="font-bold text-xl sm:text-2xl tracking-tight" title="Tasks">
              Tasks
            </h1>
            <p className="text-xs sm:text-sm text-[var(--app-muted-foreground)] font-medium">
              Manage your daily goals, image attachments, and onboarding milestones.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs font-medium">
          <span
            id="stat-total"
            className="px-2.5 py-1 rounded-full bg-[var(--app-muted)] text-[var(--app-foreground)] border border-[var(--app-border)]"
          >
            {totalCount} Total
          </span>
          <span
            id="stat-active"
            className="px-2.5 py-1 rounded-full bg-[var(--app-muted)] text-[var(--app-muted-foreground)] border border-[var(--app-border)]"
          >
            {activeCount} Active
          </span>
          <span
            id="stat-completed"
            className="px-2.5 py-1 rounded-full bg-[var(--app-muted)] text-[var(--app-muted-foreground)] border border-[var(--app-border)]"
          >
            {completedCount} Done
          </span>
        </div>
      </div>

      <div className="p-3.5 rounded-lg bg-[var(--app-muted)]/60 border border-[var(--app-border)] flex items-center justify-between flex-wrap gap-2 text-xs">
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-[var(--app-muted-foreground)] shrink-0"
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
          <span id="auth-status-text" className="text-[var(--app-muted-foreground)] font-medium truncate">
            {authStatusText}
          </span>
        </div>
        <div id="auth-buttons" className="flex items-center gap-2">
          {!currentUser ? (
            <button
              id="signin-btn"
              type="button"
              onClick={onOpenSignIn}
              className="px-3 py-1.5 rounded border border-[var(--app-border)] bg-[var(--app-foreground)] text-[var(--app-background)] font-medium hover:opacity-90 transition-opacity cursor-pointer shadow-sm"
            >
              Sign In / Register...
            </button>
          ) : (
            <>
              <button
                id="switch-user-btn"
                type="button"
                onClick={onOpenSignIn}
                className="px-2.5 py-1 rounded border border-[var(--app-border)] bg-[var(--app-card)] hover:bg-[var(--app-muted)] text-[var(--app-foreground)] font-medium transition-colors cursor-pointer"
              >
                Switch Account
              </button>
              <button
                id="signout-btn"
                type="button"
                onClick={onSignOut}
                className="px-2.5 py-1 rounded border border-[var(--app-border)] bg-[var(--app-card)] hover:bg-[var(--app-muted)] text-[var(--app-muted-foreground)] hover:text-red-500 font-medium transition-colors cursor-pointer"
              >
                Sign Out
              </button>
            </>
          )}
        </div>
      </div>

      <div className="p-3.5 rounded-lg bg-[var(--app-muted)]/40 border border-[var(--app-border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2 overflow-hidden">
          <svg
            className="w-4 h-4 text-blue-500 shrink-0"
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
          <div className="flex items-center gap-1.5 flex-wrap overflow-hidden truncate">
            <span className="font-semibold text-[var(--app-foreground)] shrink-0">FCM Push:</span>
            <span id="fcm-status-text" className="text-[var(--app-muted-foreground)] truncate">
              {fcmToken ? `Active (${fcmToken.slice(0, 10)}...)` : 'Disabled (Token requested only via user gesture)'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!fcmToken ? (
            <button
              id="fcm-enable-btn"
              type="button"
              onClick={onEnablePush}
              className="px-3 py-1 rounded border border-[var(--app-border)] bg-[var(--app-card)] hover:bg-[var(--app-muted)] text-[var(--app-foreground)] font-medium transition-colors cursor-pointer shadow-sm"
            >
              Enable Push Notifications
            </button>
          ) : (
            <button
              id="fcm-disable-btn"
              type="button"
              onClick={onRevokePush}
              className="px-2.5 py-1 rounded border border-[var(--app-border)] bg-[var(--app-card)] hover:bg-red-500/10 text-[var(--app-muted-foreground)] hover:text-red-500 font-medium transition-colors cursor-pointer"
            >
              Revoke Token
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between text-xs text-[var(--app-muted-foreground)]">
          <span className="font-medium">Completion Progress</span>
          <span id="progress-percent" className="font-mono font-semibold text-[var(--app-foreground)]">
            {percent}%
          </span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--app-muted)]">
          <div
            id="progress-bar-fill"
            className="h-full rounded-full bg-[var(--app-foreground)] transition-all duration-300 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <div className="pt-3 border-t border-[var(--app-border)] flex items-center justify-between gap-3 text-xs text-[var(--app-muted-foreground)]">
        <span className="truncate">
          Protected by Firebase Auth, Firestore, Storage, and RTDB Security Rules.
        </span>
        <button
          type="button"
          onClick={onOpenConsole}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[var(--app-border)] bg-[var(--app-card)] hover:bg-[var(--app-muted)] text-[var(--app-foreground)] font-semibold transition-colors cursor-pointer shadow-sm shrink-0"
          title="Open full-screen Pyric Developer Console with rule verification and simulation drivers"
        >
          <span>⚡</span>
          <span>Inspect Pyric Sandbox</span>
        </button>
      </div>
    </div>
  );
};
