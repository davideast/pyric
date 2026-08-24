import React from 'react';
import type { TaskItem } from '../services/firebase-service';
import { TaskItemRow } from './TaskItemRow';

interface TaskListViewProps {
  tasks: TaskItem[];
  currentUserId: string;
  activeFilter: 'all' | 'active' | 'completed';
  onFilterChange: (filter: 'all' | 'active' | 'completed') => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onToggleStatus: (id: string, newStatus: boolean, owner: string) => Promise<void>;
  onUpdateTitle: (id: string, newTitle: string, owner: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClearCompleted: () => Promise<void>;
}

export const TaskListView: React.FC<TaskListViewProps> = ({
  tasks,
  currentUserId,
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
  onToggleStatus,
  onUpdateTitle,
  onDelete,
  onClearCompleted,
}) => {
  const filtered = tasks.filter((task) => {
    const matchesFilter =
      activeFilter === 'all' ||
      (activeFilter === 'active' && !task.completed) ||
      (activeFilter === 'completed' && task.completed);
    const matchesSearch =
      !searchQuery ||
      task.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      task.category.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const activeCount = tasks.filter((t) => !t.completed).length;
  const totalCount = tasks.length;
  const completedCount = totalCount - activeCount;
  const percent = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0;
  const hasCompleted = tasks.some((t) => t.completed);

  return (
    <section className="flex flex-col gap-4 select-text cursor-default">
      <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
        <div className="relative flex-1 sm:max-w-xs">
          <svg
            className="absolute left-3.5 top-3 h-4 w-4 text-[var(--app-muted-foreground)]"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            id="search-input"
            type="text"
            placeholder="Search tasks..."
            title="Search active and completed tasks by text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="flex h-10 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-card)] pl-10 pr-4 text-xs sm:text-sm shadow-sm transition-colors placeholder:text-[var(--app-muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)]"
          />
        </div>

        <div className="inline-flex h-10 items-center justify-center rounded-lg bg-[var(--app-muted)] p-1 text-[var(--app-muted-foreground)] border border-[var(--app-border)] w-full sm:w-auto shrink-0 shadow-sm">
          <button
            type="button"
            onClick={() => onFilterChange('all')}
            id="tab-all"
            className={`tab-btn inline-flex items-center justify-center whitespace-nowrap rounded-md px-4 py-1.5 text-xs font-semibold ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-foreground)] cursor-pointer flex-1 sm:flex-initial ${
              activeFilter === 'all'
                ? 'bg-[var(--app-card)] text-[var(--app-foreground)] shadow-sm'
                : ''
            }`}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => onFilterChange('active')}
            id="tab-active"
            className={`tab-btn inline-flex items-center justify-center whitespace-nowrap rounded-md px-4 py-1.5 text-xs font-semibold ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-foreground)] cursor-pointer flex-1 sm:flex-initial ${
              activeFilter === 'active'
                ? 'bg-[var(--app-card)] text-[var(--app-foreground)] shadow-sm'
                : ''
            }`}
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => onFilterChange('completed')}
            id="tab-completed"
            className={`tab-btn inline-flex items-center justify-center whitespace-nowrap rounded-md px-4 py-1.5 text-xs font-semibold ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-foreground)] cursor-pointer flex-1 sm:flex-initial ${
              activeFilter === 'completed'
                ? 'bg-[var(--app-card)] text-[var(--app-foreground)] shadow-sm'
                : ''
            }`}
          >
            Completed
          </button>
        </div>
      </div>

      <div className="bg-[var(--app-card)] border border-[var(--app-border)] rounded-xl shadow-sm overflow-hidden min-h-[350px] flex flex-col justify-between">
        {/* Task-Adjacent Completion Progress Bar */}
        <div className="p-4 bg-[var(--app-muted)]/40 border-b border-[var(--app-border)] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <span className="text-xs font-semibold text-[var(--app-foreground)] shrink-0">
              Completion Progress
            </span>
            <div className="h-2.5 w-32 sm:w-48 overflow-hidden rounded-full bg-[var(--app-muted)] border border-[var(--app-border)]">
              <div
                className="h-full rounded-full bg-[var(--app-foreground)] transition-all duration-300"
                style={{ width: `${percent}%` }}
              ></div>
            </div>
            <span id="progress-percent" className="text-xs font-mono font-bold text-[var(--app-foreground)]">
              {percent}%
            </span>
          </div>
        </div>

        {filtered.length > 0 ? (
          <div id="todo-list" className="divide-y divide-[var(--app-border)]">
            {filtered.map((task) => (
              <TaskItemRow
                key={task.id}
                task={task}
                currentUserId={currentUserId}
                onToggleStatus={onToggleStatus}
                onUpdateTitle={onUpdateTitle}
                onDelete={onDelete}
              />
            ))}
          </div>
        ) : (
          <div
            id="empty-state"
            className="flex flex-col items-center justify-center py-16 px-4 text-center my-auto"
          >
            <div className="h-12 w-12 rounded-full border border-[var(--app-border)] bg-[var(--app-muted)] flex items-center justify-center mx-auto text-[var(--app-muted-foreground)]">
              <svg
                className="w-6 h-6"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M22 12h-6l-2 3h-4l-2-3H2" />
                <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
              </svg>
            </div>
            <h3 id="empty-title" className="font-semibold text-sm mt-3 text-[var(--app-foreground)]">
              No tasks found
            </h3>
            <p
              id="empty-subtitle"
              className="text-xs text-[var(--app-muted-foreground)] max-w-xs mx-auto"
            >
              You don't have any tasks matching your current filter or search criteria.
            </p>
          </div>
        )}

        <div className="px-4 py-3 bg-[var(--app-muted)]/40 border-t border-[var(--app-border)] flex items-center justify-between text-xs text-[var(--app-muted-foreground)]">
          <span id="items-left-count" className="font-medium">
            {activeCount} item{activeCount === 1 ? '' : 's'} left
          </span>
          {hasCompleted ? (
            <button
              type="button"
              onClick={onClearCompleted}
              className="hover:text-[var(--app-foreground)] underline underline-offset-4 transition-colors font-medium cursor-pointer"
            >
              Clear completed
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
};
