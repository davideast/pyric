/**
 * Unified file editor. Reads the active file path from
 * `useFilesStore`, fetches its content from the OPFS VFS, and writes
 * back on every change (debounced). Replaces the three single-purpose
 * editors (AppEditor, RulesEditor, CodeEditor) for any VFS-backed
 * file.
 *
 * Language detection is by extension:
 *   - `.rules`         → CodeMirror 'rules' flavor
 *   - `.tsx` / `.ts`   → 'tsx'
 *   - anything else    → 'js' (close-enough syntax highlight)
 *
 * VFS writes route through `notifyVfsWrite` so the legacy workspace
 * store stays in sync (Phase A mirror; Phase C swaps the direction).
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import { notifyVfsWrite } from '~/lib/files/bootstrap';
import { createDebouncedFileWriter } from '~/lib/files/debounced-writer';
import { useFilesStore } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

import { CmEditor, type CmLanguage } from './CmEditor';

const WRITE_DEBOUNCE_MS = 300;

function decodeText(value: string | Uint8Array): string {
  return typeof value === 'string' ? value : new TextDecoder().decode(value);
}

function languageForPath(path: string): CmLanguage {
  if (path.endsWith('.rules')) return 'rules';
  if (path.endsWith('.tsx') || path.endsWith('.ts')) return 'tsx';
  return 'js';
}

export function FileEditor() {
  const activeFilePath = useFilesStore((s) => s.activeFilePath);
  const treeVersion = useFilesStore((s) => s.treeVersion);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const writer = useRef<ReturnType<typeof createDebouncedFileWriter> | null>(null);
  if (writer.current === null) {
    writer.current = createDebouncedFileWriter({
      delayMs: WRITE_DEBOUNCE_MS,
      read: (path) => getVFS().promises.readFile(path, 'utf8').then(decodeText),
      write: (path, next) => getVFS().promises.writeFile(path, next),
      onWritten: notifyVfsWrite,
      onError: (err) => setError(err instanceof Error ? err.message : String(err)),
    });
  }

  const language = useMemo<CmLanguage>(
    () => (activeFilePath ? languageForPath(activeFilePath) : 'js'),
    [activeFilePath],
  );

  // Load the active file whenever the path or tree version changes.
  useEffect(() => {
    if (!activeFilePath) {
      setContent('');
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getVFS()
      .promises.readFile(activeFilePath, 'utf8')
      .then((value) => {
        if (cancelled) return;
        const text = decodeText(value);
        // Disk content that differs from the last known version came from
        // another writer (an agent tool); it replaces the editor text and
        // cancels the pending save typed against the old version. Disk
        // content that matches is the editor's own save, so keystrokes
        // typed since then stay.
        const external = writer.current?.observe(activeFilePath, text) ?? false;
        if (external || !writer.current?.hasPending(activeFilePath)) setContent(text);
        setLoading(false);
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (cancelled) return;
        setError(err.code === 'ENOENT' ? 'file not found' : err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeFilePath, treeVersion]);

  const handleChange = (next: string) => {
    setContent(next);
    if (!activeFilePath) return;
    writer.current?.schedule(activeFilePath, next);
  };

  if (!activeFilePath) {
    return (
      <div className="flex h-full items-center justify-center bg-content-bg p-6 text-center">
        <p className="text-[12px] text-slate-gray">
          Pick a file from the <span className="text-soft-white">Files</span> panel on the right
          to start editing.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-content-bg">
      <div className="flex shrink-0 items-center justify-between border-b border-[#2a2a35] px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-slate-gray" title={activeFilePath}>
          {activeFilePath}
        </span>
        {error ? (
          <span className="font-mono text-[10px] text-[#f0a0a0]">{error}</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <p className="p-3 font-mono text-[11px] text-slate-gray">loading…</p>
        ) : (
          <CmEditor value={content} onChange={handleChange} language={language} />
        )}
      </div>
    </div>
  );
}
