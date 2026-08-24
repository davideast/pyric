import React, { useRef, useState, useTransition } from 'react';

interface TaskCreationFormProps {
  onAddTask: (
    title: string,
    category: string,
    priority: 'Low' | 'Medium' | 'High',
    attachmentUrl?: string
  ) => Promise<void>;
  onUploadAttachment: (file: File) => Promise<string>;
  onError: (title: string, err: any) => void;
}

export const TaskCreationForm: React.FC<TaskCreationFormProps> = ({
  onAddTask,
  onUploadAttachment,
  onError,
}) => {
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('Work');
  const [priority, setPriority] = useState<'Low' | 'Medium' | 'High'>('Medium');
  const [attachmentUrl, setAttachmentUrl] = useState<string | undefined>(undefined);
  const [attachmentName, setAttachmentName] = useState<string | undefined>(undefined);
  const [isPending, startTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const currentTitle = title.trim();
    const currentCategory = category;
    const currentPriority = priority;
    const currentAttachmentUrl = attachmentUrl;

    setTitle('');
    setAttachmentUrl(undefined);
    setAttachmentName(undefined);

    startTransition(() => {
      onAddTask(currentTitle, currentCategory, currentPriority, currentAttachmentUrl).catch((err) => {
        onError('Create Task Denied', err);
      });
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setAttachmentName('Uploading ' + file.name + '...');
      const url = await onUploadAttachment(file);
      setAttachmentUrl(url);
      setAttachmentName(file.name);
    } catch (err: any) {
      setAttachmentName(undefined);
      onError('Attachment Upload Denied', err);
    }
  };

  return (
    <div className="bg-[var(--app-card)] border border-[var(--app-border)] rounded-xl p-5 sm:p-6 shadow-sm select-text cursor-default">
      <form id="add-task-form" className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            id="new-task-input"
            type="text"
            placeholder="What needs to be done?"
            autoComplete="off"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isPending}
            className="flex h-11 w-full flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-background)] px-3.5 py-2.5 text-sm shadow-inner transition-colors placeholder:text-[var(--app-muted-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button
            id="add-task-btn"
            type="submit"
            disabled={isPending}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] disabled:pointer-events-none disabled:opacity-50 bg-[var(--app-foreground)] text-[var(--app-background)] hover:opacity-90 h-11 px-5 py-2.5 shadow-sm gap-2 shrink-0 cursor-pointer"
          >
            <svg
              className="w-4 h-4"
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
            <span>{isPending ? 'Adding...' : 'Add Task'}</span>
          </button>
        </div>

        {attachmentName ? (
          <div className="flex items-center justify-between p-2 rounded-md bg-[var(--app-muted)] border border-[var(--app-border)] text-xs">
            <span className="truncate font-medium text-[var(--app-foreground)]">
              📎 Attachment: {attachmentName}
            </span>
            <button
              type="button"
              onClick={() => {
                setAttachmentUrl(undefined);
                setAttachmentName(undefined);
              }}
              className="px-2 py-0.5 rounded text-red-500 font-bold hover:underline"
            >
              &times; Remove
            </button>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-4 pt-3 border-t border-[var(--app-border)] text-xs text-[var(--app-muted-foreground)]">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-[var(--app-muted-foreground)]">Category:</span>
              <select
                id="task-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                disabled={isPending}
                className="h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-card)] px-2.5 text-xs font-semibold text-[var(--app-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] cursor-pointer shadow-sm"
              >
                <option value="Work">Work</option>
                <option value="Personal">Personal</option>
                <option value="Project">Project</option>
                <option value="Study">Study</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="font-medium text-[var(--app-muted-foreground)]">Priority:</span>
              <select
                id="task-priority"
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'Low' | 'Medium' | 'High')}
                disabled={isPending}
                className="h-8 rounded-md border border-[var(--app-border)] bg-[var(--app-card)] px-2.5 text-xs font-semibold text-[var(--app-foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--app-foreground)] cursor-pointer shadow-sm"
              >
                <option value="Medium">Medium</option>
                <option value="High">High</option>
                <option value="Low">Low</option>
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPending}
                className="h-8 px-2.5 rounded-md border border-[var(--app-border)] bg-[var(--app-card)] text-xs font-semibold text-[var(--app-foreground)] hover:bg-[var(--app-muted)] cursor-pointer shadow-sm flex items-center gap-1.5"
              >
                <span>📎 Attach Image</span>
              </button>
              <input
                ref={fileInputRef}
                id="attachment-file-input"
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
            </div>
          </div>

          <div className="hidden sm:flex items-center gap-1.5">
            <span className="font-medium">Quick submit:</span>
            <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border border-[var(--app-border)] bg-[var(--app-muted)] px-1.5 font-mono text-[10px] font-semibold text-[var(--app-foreground)] shadow-sm">
              Enter ↵
            </kbd>
          </div>
        </div>
      </form>
    </div>
  );
};
