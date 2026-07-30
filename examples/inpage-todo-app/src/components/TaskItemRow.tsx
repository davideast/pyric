import React, { memo, useState } from 'react';
import type { TaskItem } from '../services/firebase-service';

interface TaskItemRowProps {
  task: TaskItem;
  currentUserId: string;
  onToggleStatus: (id: string, newStatus: boolean, owner: string) => Promise<void>;
  onUpdateTitle: (id: string, newTitle: string, owner: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const TaskItemRow: React.FC<TaskItemRowProps> = memo(
  ({ task, currentUserId, onToggleStatus, onUpdateTitle, onDelete }) => {
    const [isEditing, setIsEditing] = useState(false);
    const [editValue, setEditValue] = useState(task.title);

    const handleToggle = () => {
      onToggleStatus(task.id, !task.completed, task.owner);
    };

    const handleCommitEdit = async () => {
      if (!editValue.trim()) {
        setIsEditing(false);
        setEditValue(task.title);
        return;
      }
      if (editValue.trim() !== task.title) {
        await onUpdateTitle(task.id, editValue.trim(), task.owner);
      }
      setIsEditing(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        handleCommitEdit();
      } else if (e.key === 'Escape') {
        setIsEditing(false);
        setEditValue(task.title);
      }
    };

    const priorityBadgeClass =
      task.priority === 'High'
        ? 'bg-red-500/15 border-red-500/30 text-red-400'
        : task.priority === 'Medium'
          ? 'bg-amber-500/15 border-amber-500/30 text-amber-400'
          : 'bg-zinc-800 border-zinc-700 text-zinc-400';

    return (
      <div
        className={`group flex items-center justify-between p-3.5 sm:px-4 sm:py-3 gap-3 border-b border-zinc-800 hover:bg-zinc-900/40 transition-colors ${task.completed ? 'opacity-70' : ''}`}
      >
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <button
            type="button"
            onClick={handleToggle}
            className={`w-5 h-5 rounded border border-zinc-700 flex items-center justify-center transition-colors shrink-0 ${task.completed ? 'bg-white border-white text-zinc-950 font-bold' : 'bg-transparent text-transparent hover:border-zinc-500'}`}
          >
            ✓
          </button>
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            {isEditing ? (
              <div className="flex items-center gap-2 w-full">
                <input
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={handleCommitEdit}
                  autoFocus
                  className="h-8 w-full rounded border border-zinc-700 bg-zinc-950 px-2 text-xs text-white font-medium focus:outline-none focus:ring-1 focus:ring-zinc-400"
                />
              </div>
            ) : (
              <div className="flex items-center flex-wrap gap-2">
                <span
                  onDoubleClick={() => setIsEditing(true)}
                  className={`text-sm font-medium truncate cursor-pointer ${task.completed ? 'line-through text-zinc-500' : 'text-zinc-100'}`}
                >
                  {task.title}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 font-mono text-[10px] text-zinc-300 font-semibold">
                  {task.category}
                </span>
                <span className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-semibold border ${priorityBadgeClass}`}>
                  {task.priority}
                </span>
                <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-800 font-mono text-[10px] text-zinc-400">
                  owner: {task.owner}
                </span>
              </div>
            )}
            {task.attachmentUrl ? (
              <div className="inline-flex items-center gap-2 mt-1">
                <a
                  href={task.attachmentUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 underline font-medium"
                >
                  <span>📎 View Attached Image Asset</span>
                </a>
              </div>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button
            type="button"
            onClick={() => setIsEditing(true)}
            className="text-xs px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 font-semibold"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={() => onDelete(task.id)}
            className="text-xs px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 font-semibold"
          >
            Delete
          </button>
        </div>
      </div>
    );
  }
);
