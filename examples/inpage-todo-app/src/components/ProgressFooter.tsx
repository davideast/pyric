import React from 'react';
import type { TaskItem } from '../services/firebase-service';

interface ProgressFooterProps {
  tasks: TaskItem[];
  onClearCompleted: () => Promise<void>;
  onOpenConsole: () => void;
}

export const ProgressFooter: React.FC<ProgressFooterProps> = ({
  tasks,
  onClearCompleted,
  onOpenConsole,
}) => {
  const activeCount = tasks.filter((t) => !t.completed).length;
  const totalCount = tasks.length;
  const percent =
    totalCount > 0 ? Math.round(((totalCount - activeCount) / totalCount) * 100) : 0;
  const hasCompleted = tasks.some((t) => t.completed);

  return (
    <footer className="flex flex-col gap-4 rounded-2xl bg-zinc-900/60 border border-zinc-800 p-5 shadow-xl select-text cursor-default">
      <div className="flex items-center justify-between text-xs font-semibold text-zinc-400 flex-wrap gap-2">
        <span id="items-left-count" className="font-medium">
          {activeCount} item{activeCount === 1 ? '' : 's'} remaining
        </span>
        {hasCompleted ? (
          <button
            id="clear-completed-btn"
            type="button"
            onClick={onClearCompleted}
            className="text-xs text-red-400 hover:text-red-300 underline font-medium"
          >
            Clear completed items
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex justify-between items-center text-xs text-zinc-400">
          <span className="font-medium">Workspace Completion Rate</span>
          <strong id="progress-percent" className="font-bold text-white">
            {percent}%
          </strong>
        </div>
        <div className="h-2 w-full rounded-full bg-zinc-950 overflow-hidden border border-zinc-800">
          <div
            id="progress-bar-fill"
            className="h-full bg-white transition-all duration-500 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
      <div className="flex items-center justify-between border-t border-zinc-800 pt-4 text-xs flex-wrap gap-3">
        <span className="text-zinc-400 font-medium">
          Powered by Pyric In-Page Sandbox & reactive Web SDK abstractions.
        </span>
        <button
          type="button"
          onClick={onOpenConsole}
          className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-bold border border-zinc-700 shadow-md transition-colors flex items-center gap-2"
        >
          <span>⚡ Inspect Pyric Sandbox</span>
          <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-mono text-[10px]">
            Console
          </span>
        </button>
      </div>
    </footer>
  );
};
