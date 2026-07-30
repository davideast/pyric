import React from 'react';
import type { TaskItem } from '../services/firebase-service';
import { TaskItemRow } from './TaskItemRow';

interface TaskListViewProps {
  tasks: TaskItem[];
  currentUserId: string;
  activeFilter: 'all' | 'active' | 'completed';
  searchQuery: string;
  onToggleStatus: (id: string, newStatus: boolean, owner: string) => Promise<void>;
  onUpdateTitle: (id: string, newTitle: string, owner: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const TaskListView: React.FC<TaskListViewProps> = ({
  tasks,
  currentUserId,
  activeFilter,
  searchQuery,
  onToggleStatus,
  onUpdateTitle,
  onDelete,
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

  return (
    <section className="flex flex-col rounded-2xl bg-zinc-900/30 border border-zinc-800 overflow-hidden shadow-lg min-h-[220px] select-text cursor-default">
      {filtered.length > 0 ? (
        <div id="todo-list" className="flex flex-col divide-y divide-zinc-800/60">
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
          className="flex-1 flex flex-col items-center justify-center p-12 gap-3 text-center text-zinc-500"
        >
          <span className="text-3xl">🗂️</span>
          <strong className="text-sm font-semibold text-zinc-400">
            No active tasks in this workspace view
          </strong>
          <p className="text-xs text-zinc-500 max-w-sm">
            Create a task item using the form above or sign in with a demo account to evaluate reactive
            Firestore rules and live data sync.
          </p>
        </div>
      )}
    </section>
  );
};
