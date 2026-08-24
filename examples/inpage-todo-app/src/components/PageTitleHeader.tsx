import React from 'react';
import type { TaskItem } from '../services/firebase-service';

interface PageTitleHeaderProps {
  tasks: TaskItem[];
}

export const PageTitleHeader: React.FC<PageTitleHeaderProps> = ({ tasks }) => {
  const totalCount = tasks.length;
  const activeCount = tasks.filter((t) => !t.completed).length;
  const completedCount = totalCount - activeCount;

  return (
    <div className="flex items-end justify-between flex-wrap gap-4 pb-1 select-text cursor-default">
      <div className="flex flex-col gap-1">
        <h1 className="font-bold text-2xl sm:text-3xl tracking-tight text-[var(--app-foreground)]" title="Tasks">
          Tasks
        </h1>
        <p className="text-xs sm:text-sm text-[var(--app-muted-foreground)] font-medium">
          Manage your daily goals, image attachments, and onboarding milestones.
        </p>
      </div>

      <div className="flex items-center gap-1.5 text-xs font-medium">
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
  );
};
