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
  activeFilter: 'all' | 'active' | 'completed';
  onFilterChange: (filter: 'all' | 'active' | 'completed') => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
}

export const TaskCreationForm: React.FC<TaskCreationFormProps> = ({
  onAddTask,
  onUploadAttachment,
  onError,
  activeFilter,
  onFilterChange,
  searchQuery,
  onSearchChange,
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
    <section className="flex flex-col gap-4 rounded-2xl bg-zinc-900/40 border border-zinc-800 p-5 shadow-lg select-text cursor-default">
      <form id="add-task-form" onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 flex flex-col sm:flex-row gap-2.5 min-w-0">
          <input
            id="new-task-input"
            type="text"
            placeholder="Describe a new task item..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isPending}
            className="h-10 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 text-sm text-white font-medium placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          <div className="flex items-center gap-2 shrink-0">
            <select
              id="task-category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={isPending}
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs font-semibold text-zinc-300 focus:outline-none focus:border-zinc-500"
            >
              <option value="Work">Work</option>
              <option value="Personal">Personal</option>
              <option value="Urgent">Urgent</option>
              <option value="Study">Study</option>
            </select>
            <select
              id="task-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as 'Low' | 'Medium' | 'High')}
              disabled={isPending}
              className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs font-semibold text-zinc-300 focus:outline-none focus:border-zinc-500"
            >
              <option value="Low">Low Priority</option>
              <option value="Medium">Medium Priority</option>
              <option value="High">High Priority</option>
            </select>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isPending}
            className="h-10 px-3 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 font-semibold text-xs transition-colors flex items-center gap-1.5 shrink-0"
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
          <button
            type="submit"
            disabled={isPending}
            className="h-10 px-5 rounded-lg bg-white text-zinc-950 hover:bg-zinc-200 font-bold text-sm transition-colors shrink-0 shadow-md"
          >
            {isPending ? 'Saving...' : '+ Create Task'}
          </button>
        </div>
      </form>

      {attachmentName ? (
        <div
          id="attachment-chip"
          className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-xs"
        >
          <span className="inline-flex items-center gap-2 truncate text-blue-400 font-medium">
            <span>📎 Selected image asset:</span>
            <strong id="attachment-filename" className="text-white truncate max-w-[240px]">
              {attachmentName}
            </strong>
          </span>
          <button
            type="button"
            onClick={() => {
              setAttachmentUrl(undefined);
              setAttachmentName(undefined);
            }}
            className="px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold text-[11px]"
          >
            &times; Remove
          </button>
        </div>
      ) : null}

      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-zinc-800/80 pt-4">
        <div className="flex items-center gap-1.5 bg-zinc-950 p-1 rounded-lg border border-zinc-800 text-xs font-semibold w-full sm:w-auto overflow-x-auto">
          <button
            id="tab-all"
            type="button"
            onClick={() => onFilterChange('all')}
            className={`px-4 py-1.5 rounded-md font-bold shadow-sm ${
              activeFilter === 'all'
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-400 hover:text-white font-normal'
            }`}
          >
            All Tasks
          </button>
          <button
            id="tab-active"
            type="button"
            onClick={() => onFilterChange('active')}
            className={`px-4 py-1.5 rounded-md font-bold shadow-sm ${
              activeFilter === 'active'
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-400 hover:text-white font-normal'
            }`}
          >
            Active
          </button>
          <button
            id="tab-completed"
            type="button"
            onClick={() => onFilterChange('completed')}
            className={`px-4 py-1.5 rounded-md font-bold shadow-sm ${
              activeFilter === 'completed'
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-400 hover:text-white font-normal'
            }`}
          >
            Completed
          </button>
        </div>
        <input
          id="search-input"
          type="text"
          placeholder="Filter active tasks by keyword..."
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="h-9 w-full sm:w-64 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs text-white font-medium placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
        />
      </div>
    </section>
  );
};
