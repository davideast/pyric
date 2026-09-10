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
import { useFilesStore } from '~/lib/store/files';
import { useChatStore } from '~/lib/store/chat';
import { isSessionWriter, subscribeSessionWriter } from '~/lib/sessions/writer-lock';
import { getVFS, isVFSReadOnly, withWriteMutex } from '~/lib/vfs';

import { CmEditor, type CmLanguage } from './CmEditor';

const WRITE_DEBOUNCE_MS = 300;

function languageForPath(path: string): CmLanguage {
  if (path.endsWith('.rules')) return 'rules';
  if (path.endsWith('.tsx') || path.endsWith('.ts')) return 'tsx';
  return 'js';
}

export function FileEditor() {
  const activeFilePath = useFilesStore((s) => s.activeFilePath);
  const treeVersion = useFilesStore((s) => s.treeVersion);
  const isAgentRunning = useChatStore((s) => s.messages.some((m) => m.streaming));
  const [isWriter, setIsWriter] = useState<boolean>(() => isSessionWriter());

  useEffect(() => {
    return subscribeSessionWriter((status) => {
      setIsWriter(status === 'writer');
    });
  }, []);

  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const writeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrittenContent = useRef<string>('');
  const loadedRevision = useRef<number>(0);

  // Single-tab readOnly lock: disable editor while an agent turn is actively running
  // or when the tab does not hold the session writer lock.
  const readOnly = !isWriter || isVFSReadOnly() || isAgentRunning;

  const language = useMemo<CmLanguage>(
    () => (activeFilePath ? languageForPath(activeFilePath) : 'js'),
    [activeFilePath],
  );

  // Cancel any pending debounced save when the editor becomes read-only.
  useEffect(() => {
    if (readOnly && writeTimeout.current) {
      clearTimeout(writeTimeout.current);
      writeTimeout.current = null;
    }
  }, [readOnly]);

  // Load the active file whenever the path or tree version changes.
  useEffect(() => {
    // Tree version bumped or active file changed — cancel pending manual save
    // so stale edits cannot overwrite concurrent tool writes.
    if (writeTimeout.current) {
      clearTimeout(writeTimeout.current);
      writeTimeout.current = null;
    }

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
        const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
        setContent(text);
        lastWrittenContent.current = text;
        loadedRevision.current = treeVersion;
        setLoading(false);
      })
      .catch((err: NodeJS.ErrnoException) => {
        if (cancelled) return;
        setError(err.code === 'ENOENT' ? 'file not found' : err.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      if (writeTimeout.current) {
        clearTimeout(writeTimeout.current);
        writeTimeout.current = null;
      }
    };
  }, [activeFilePath, treeVersion]);

  const handleChange = (next: string) => {
    if (readOnly) return;
    setContent(next);
    if (!activeFilePath) return;
    if (writeTimeout.current) clearTimeout(writeTimeout.current);
    const queuedRevision = treeVersion;
    writeTimeout.current = setTimeout(async () => {
      // Concurrency and revision check: if treeVersion changed since this edit was queued,
      // a concurrent tool write occurred — drop the stale debounced save.
      if (useFilesStore.getState().treeVersion !== queuedRevision) return;
      if (readOnly || isVFSReadOnly() || !isSessionWriter()) return;
      if (next === lastWrittenContent.current) return;
      try {
        await withWriteMutex(async () => {
          // Re-verify revision inside the write mutex
          if (useFilesStore.getState().treeVersion !== queuedRevision) return;
          await getVFS().promises.writeFile(activeFilePath, next);
          lastWrittenContent.current = next;
          notifyVfsWrite(activeFilePath, next);
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }, WRITE_DEBOUNCE_MS);
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
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate font-mono text-[11px] text-slate-gray" title={activeFilePath}>
            {activeFilePath}
          </span>
          {readOnly ? (
            <span className="font-mono text-[10px] text-slate-gray bg-[#1f1f28] px-1.5 py-0.5 rounded border border-[#2a2a35]">
              {isAgentRunning ? 'agent writing…' : 'read-only'}
            </span>
          ) : null}
        </div>
        {error ? (
          <span className="font-mono text-[10px] text-[#f0a0a0]">{error}</span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <p className="p-3 font-mono text-[11px] text-slate-gray">loading…</p>
        ) : (
          <CmEditor value={content} onChange={handleChange} language={language} readOnly={readOnly} />
        )}
      </div>
    </div>
  );
}
