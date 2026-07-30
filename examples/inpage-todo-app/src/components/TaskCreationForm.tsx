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
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  const [attachmentName, setAttachmentName] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    startTransition(async () => {
      try {
        await onAddTask(title, category, priority, attachmentUrl || undefined);
        setTitle('');
        setAttachmentUrl(null);
        setAttachmentName(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      } catch (err: any) {
        onError('Firestore Write Denied by Security Rules', err);
      }
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];

    try {
      const url = await onUploadAttachment(file);
      setAttachmentUrl(url);
      setAttachmentName(file.name);
    } catch (err: any) {
      onError('Firebase Storage Upload Denied', err);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const clearAttachment = () => {
    setAttachmentUrl(null);
    setAttachmentName(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <section className="flex flex-col gap-4 rounded-2xl bg-zinc-900/40 border border-zinc-800 p-5 shadow-lg w-full">
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row gap-3">
        <div className="flex-1 flex flex-col sm:flex-row gap-2.5 min-w-0">
          <input
            type="text"
            placeholder="Describe a new task item..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isPending}
            className="h-10 flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 text-sm text-white font-medium placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500 transition-colors"
          />
          <div className="flex items-center gap-2 shrink-0">
            <select
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
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="submit"
            disabled={isPending}
            className="h-10 px-5 rounded-lg bg-white text-zinc-950 hover:bg-zinc-200 font-bold text-sm transition-colors shrink-0 shadow-md disabled:opacity-50"
          >
            {isPending ? '⏳ Saving...' : '+ Create Task'}
          </button>
        </div>
      </form>

      {/* Selected Attachment Chip */}
      {attachmentName ? (
        <div className="inline-flex items-center justify-between p-2.5 rounded-lg bg-zinc-900 border border-zinc-700 text-xs">
          <span className="inline-flex items-center gap-2 truncate text-blue-400 font-medium">
            <span>📎 Selected image asset:</span>
            <strong className="text-white truncate max-w-[240px]">{attachmentName}</strong>
          </span>
          <button
            type="button"
            onClick={clearAttachment}
            className="px-2 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold text-[11px]"
          >
            &times; Remove
          </button>
        </div>
      ) : null}
    </section>
  );
};
