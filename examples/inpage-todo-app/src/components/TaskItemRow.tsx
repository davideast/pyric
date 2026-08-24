import React, { useState } from 'react';
import type { TaskItem } from '../services/firebase-service';

interface TaskItemRowProps {
  task: TaskItem;
  currentUserId: string;
  onToggleStatus: (id: string, newStatus: boolean, owner: string) => Promise<void>;
  onUpdateTitle: (id: string, newTitle: string, owner: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

export const TaskItemRow: React.FC<TaskItemRowProps> = ({
  task,
  currentUserId,
  onToggleStatus,
  onUpdateTitle,
  onDelete,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(task.title);

  const handleToggle = () => {
    onToggleStatus(task.id, !task.completed, currentUserId);
  };

  const handleCommitEdit = () => {
    setIsEditing(false);
    if (editValue.trim() && editValue.trim() !== task.title) {
      onUpdateTitle(task.id, editValue.trim(), currentUserId);
    } else {
      setEditValue(task.title);
    }
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
      ? 'bg-red-500/10 text-red-500 border-red-500/20'
      : task.priority === 'Medium'
        ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
        : 'bg-blue-500/10 text-blue-500 border-blue-500/20';

  return (
    <div
      className={`group flex items-center justify-between p-3.5 sm:px-4 sm:py-3.5 gap-3 transition-colors hover:bg-[var(--app-muted)]/30 ${
        task.completed ? 'opacity-70' : ''
      }`}
    >
      <div className="flex items-start sm:items-center gap-3 flex-1 min-w-0">
        <button
          type="button"
          onClick={handleToggle}
          className={`custom-checkbox mt-0.5 sm:mt-0 shrink-0 ${
            task.completed ? 'checked-checkbox' : ''
          }`}
          title={task.completed ? 'Mark as incomplete' : 'Mark as completed'}
        >
          <svg
            className={`w-3.5 h-3.5 ${task.completed ? 'block' : 'hidden'}`}
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </button>

        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
          {isEditing ? (
            <div className="flex items-center gap-2 w-full">
              <input
                id={`edit-input-${task.id}`}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleCommitEdit}
                autoFocus
                className="h-8 w-full rounded border border-[var(--app-border)] bg-[var(--app-card)] px-2 text-xs font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)]"
              />
            </div>
          ) : (
            <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
              <span
                onDoubleClick={() => {
                  setEditValue(task.title);
                  setIsEditing(true);
                }}
                className={`text-sm font-medium leading-tight truncate max-w-full cursor-pointer transition-all ${
                  task.completed ? 'line-through text-[var(--app-muted-foreground)]' : 'text-[var(--app-foreground)]'
                }`}
                title="Double-click to edit"
              >
                {task.title}
              </span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="inline-flex items-center rounded-md bg-[var(--app-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-muted-foreground)]">
                  {task.category || 'Work'}
                </span>
                <span
                  className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${priorityBadgeClass}`}
                >
                  {task.priority || 'Medium'}
                </span>
              </div>
            </div>
          )}

          {task.attachmentUrl ? (
            <div className="inline-flex items-center gap-2 p-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-card)] text-xs shadow-sm max-w-xs">
              <img
                src={task.attachmentUrl}
                alt="attachment"
                className="w-9 h-9 rounded object-cover border border-[var(--app-border)] shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-[11px] truncate text-[var(--app-foreground)]">
                  Image Attachment
                </div>
                <div className="text-[10px] text-[var(--app-muted-foreground)]">
                  Firebase Storage
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={() => {
            setEditValue(task.title);
            setIsEditing(true);
          }}
          className="h-8 w-8 rounded-md hover:bg-[var(--app-muted)] text-[var(--app-muted-foreground)] hover:text-[var(--app-foreground)] inline-flex items-center justify-center transition-colors cursor-pointer"
          title="Edit task"
        >
          <svg
            className="w-3.5 h-3.5"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => onDelete(task.id)}
          className="h-8 w-8 rounded-md hover:bg-[var(--app-muted)] hover:text-red-500 text-[var(--app-muted-foreground)] inline-flex items-center justify-center transition-colors cursor-pointer"
          title="Delete task"
        >
          <svg
            className="w-3.5 h-3.5"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 6h18" />
            <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
            <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          </svg>
        </button>
      </div>
    </div>
  );
};
