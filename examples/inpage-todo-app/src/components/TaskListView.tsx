import React, { useMemo, useState } from 'react';
import type { TaskItem } from '../services/firebase-service';
import { TaskItemRow } from './TaskItemRow';

interface TaskListViewProps {
  tasks: TaskItem[];
  currentUserId: string;
  onToggleStatus: (id: string, newStatus: boolean, owner: string) => Promise<void>;
  onUpdateTitle: (id: string, newTitle: string, owner: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const TaskListView: React.FC<TaskListViewProps> = ({
  tasks,
  currentUserId,
  onToggleStatus,
  onUpdateTitle,
  onDelete,
}) => {
  const [filter, setFilter] = useState<'all' | 'active' | 'completed'>('all');
  const [search, setSearch] = useState('');

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      const matchesFilter =
        filter === 'all' ||
        (filter === 'active' && !task.completed) ||
        (filter === 'completed' && task.completed);
      const matchesSearch =
        !search ||
        task.title.toLowerCase().includes(search.toLowerCase()) ||
        task.category.toLowerCase().includes(search.toLowerCase());
      return matchesFilter && matchesSearch;
    });
  }, [tasks, filter, search]);

  return (
    <section className="flex flex-col rounded-2xl bg-zinc-900/30 border border-zinc-800 overflow-hidden shadow-lg min-h-[220px] w-full">
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 p-4 border-b border-zinc-800">
        <div className="flex items-center gap-1.5 bg-zinc-950 p-1 rounded-lg border border-zinc-800 text-xs font-semibold">
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`px-4 py-1.5 rounded-md transition-all ${filter === 'all' ? 'bg-zinc-800 text-white font-bold shadow-sm' : 'text-zinc-400 hover:text-white'}`}
          >
            All Tasks
          </button>
          <button
            type="button"
            onClick={() => setFilter('active')}
            className={`px-4 py-1.5 rounded-md transition-all ${filter === 'active' ? 'bg-zinc-800 text-white font-bold shadow-sm' : 'text-zinc-400 hover:text-white'}`}
          >
            Active
          </button>
          <button
            type="button"
            onClick={() => setFilter('completed')}
            className={`px-4 py-1.5 rounded-md transition-all ${filter === 'completed' ? 'bg-zinc-800 text-white font-bold shadow-sm' : 'text-zinc-400 hover:text-white'}`}
          >
            Completed
          </button>
        </div>
        <input
          type="text"
          placeholder="Filter active tasks by keyword..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-9 w-full sm:w-64 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs text-white font-medium placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
        />
      </div>

      {filteredTasks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-12 gap-3 text-center text-zinc-500">
          <span className="text-3xl">🗂️</span>
          <strong className="text-sm font-semibold text-zinc-400">
            No active tasks in this workspace view
          </strong>
          <p className="text-xs text-zinc-500 max-w-sm">
            Create a task item using the form above or sign in with a demo account to evaluate reactive Firestore rules and live data sync.
          </p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-zinc-800/60">
          {filteredTasks.map((task) => (
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
      )}
    </section>
  );
};
