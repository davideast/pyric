/**
 * Right-panel Files tab. Three sub-tabs:
 *
 *   - Files     — OPFS VFS tree under /workspace. Click → activates a
 *                 file (FileEditor in the left panel reads it).
 *   - Git       — clone / commit / push (powered by GitView).
 *   - Packages  — esm.sh install / uninstall (powered by PackagesView).
 *
 * The Files sub-tab affordances:
 *   - "+ new file" creates an empty file at the resolved absolute path.
 *   - Per-row delete (disabled for pinned paths like firestore.rules).
 *
 * Tree refresh is driven by `treeVersion` in `useFilesStore`; any
 * VFS write that goes through `notifyVfsWrite` (FileEditor, file
 * tools, bootstrap) bumps it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { bootstrapWorkspaceFiles, notifyVfsWrite } from '~/lib/files/bootstrap';
import { listTree, type TreeNode } from '~/lib/files/file-tree';
import { isPinned, useFilesStore, WORKSPACE_ROOT } from '~/lib/store/files';
import { useMobileNavStore } from '~/lib/store/mobile-nav';
import { getVFS } from '~/lib/vfs';

import { GitView, PackagesView } from './RepoTab';

type SubTab = 'files' | 'git' | 'packages';

export function FilesPanel() {
  const [subTab, setSubTab] = useState<SubTab>('files');
  return (
    <div className="flex h-full min-h-0 flex-col bg-content-bg">
      <div className="flex shrink-0 border-b border-[#2a2a35] px-3">
        {(['files', 'git', 'packages'] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setSubTab(id)}
            className={[
              'px-3 py-2 text-[12px] font-medium uppercase tracking-wider transition-colors',
              subTab === id ? 'text-soft-white' : 'text-slate-gray hover:text-soft-white/80',
            ].join(' ')}
          >
            {id}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {subTab === 'files' ? <FilesTreeView /> : null}
        {subTab === 'git' ? (
          <div className="h-full overflow-auto">
            <GitView />
          </div>
        ) : null}
        {subTab === 'packages' ? (
          <div className="h-full overflow-auto">
            <PackagesView />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FilesTreeView() {
  const activeFilePath = useFilesStore((s) => s.activeFilePath);
  const setActiveFilePath = useFilesStore((s) => s.setActiveFilePath);
  const treeVersion = useFilesStore((s) => s.treeVersion);
  const bumpTree = useFilesStore((s) => s.bumpTree);
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newPath, setNewPath] = useState<string>('');
  const [newPathOpen, setNewPathOpen] = useState<boolean>(false);

  // Bootstrap the VFS workspace before first paint.
  useEffect(() => {
    let cancelled = false;
    bootstrapWorkspaceFiles().then(() => {
      if (!cancelled) bumpTree();
    });
    return () => {
      cancelled = true;
    };
  }, [bumpTree]);

  // Reload the tree whenever a write bumps the version.
  useEffect(() => {
    let cancelled = false;
    listTree(WORKSPACE_ROOT)
      .then((root) => {
        if (!cancelled) setTree(root);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [treeVersion]);

  const handleCreate = useCallback(async () => {
    const raw = newPath.trim();
    if (!raw) return;
    const path = raw.startsWith('/') ? raw : `${WORKSPACE_ROOT}/${raw}`;
    if (!path.startsWith(`${WORKSPACE_ROOT}/`)) {
      setError(`files must live under ${WORKSPACE_ROOT}/`);
      return;
    }
    try {
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent && parent !== WORKSPACE_ROOT) {
        await getVFS().promises.mkdir(parent, { recursive: true });
      }
      await getVFS().promises.writeFile(path, '');
      notifyVfsWrite(path, '');
      setActiveFilePath(path);
      setNewPath('');
      setNewPathOpen(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [newPath, setActiveFilePath]);

  const handleDelete = useCallback(
    async (node: TreeNode) => {
      if (isPinned(node.path)) return;
      try {
        if (node.type === 'dir') {
          // Directories may contain anything (cloned repos, stale
          // OPFS artefacts from past sessions like `piebox`). A flat
          // unlink would fail; confirm + rmdir(recursive) for parity
          // with what the terminal's `rm -r` already supports.
          const confirmed =
            typeof window === 'undefined'
              ? true
              : window.confirm(
                  `Delete '${node.path}' and everything inside it? This can't be undone.`,
                );
          if (!confirmed) return;
          await getVFS().promises.rmdir(node.path, { recursive: true });
        } else {
          await getVFS().promises.unlink(node.path);
        }
        notifyVfsWrite(node.path, '');
        if (activeFilePath === node.path) setActiveFilePath(null);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [activeFilePath, setActiveFilePath],
  );

  const rootChildren = useMemo(() => tree?.children ?? [], [tree]);

  /**
   * Pick a file. Beyond the file-store update, this also routes the
   * mobile bottom-tab over to "app" — on phone widths the
   * WorkspacePanel (where FileEditor lives) sits on the App tab,
   * so a tap inside the Files tree would otherwise leave the user
   * stuck on the tree with no visible editor. Harmless on desktop:
   * the mobile-nav state is ignored at md+ widths.
   */
  const handleSelectFile = useCallback(
    (path: string) => {
      setActiveFilePath(path);
      useMobileNavStore.getState().setActive('app');
    },
    [setActiveFilePath],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-content-bg">
      <div className="flex shrink-0 items-center justify-between border-b border-[#2a2a35] px-3 py-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-gray">files</p>
        <button
          type="button"
          onClick={() => setNewPathOpen((v) => !v)}
          className="rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:border-soft-white hover:text-soft-white"
        >
          + new file
        </button>
      </div>
      {newPathOpen ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-[#2a2a35] px-3 py-2">
          <input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
              if (e.key === 'Escape') setNewPathOpen(false);
            }}
            placeholder="src/components/Foo.tsx"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            className="flex-1 rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[11px] text-soft-white focus:outline-none focus:border-[#3a3a48]"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            className="rounded border border-[#2a2a35] bg-[#0f0f17] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:border-soft-white hover:text-soft-white"
          >
            create
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="shrink-0 px-3 py-1 font-mono text-[10px] text-[#f0a0a0]">{error}</p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {rootChildren.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-slate-gray">empty</p>
        ) : (
          <ul>
            {rootChildren.map((child) => (
              <TreeEntry
                key={child.path}
                node={child}
                depth={0}
                activePath={activeFilePath}
                onSelect={handleSelectFile}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TreeEntry({
  node,
  depth,
  activePath,
  onSelect,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  activePath: string | null;
  onSelect: (path: string) => void;
  onDelete: (node: TreeNode) => void;
}) {
  const [open, setOpen] = useState<boolean>(depth < 1);
  const isActive = activePath === node.path;
  const pinned = isPinned(node.path);
  const padLeft = 12 + depth * 12;

  if (node.type === 'dir') {
    return (
      <li>
        <div className="group flex items-center justify-between">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex flex-1 items-center gap-1.5 py-1 text-left font-mono text-[11px] text-slate-gray hover:text-soft-white"
            style={{ paddingLeft: padLeft, paddingRight: 6 }}
          >
            <span className="material-symbols-outlined text-[14px]">
              {open ? 'expand_more' : 'chevron_right'}
            </span>
            <span>{node.name}</span>
          </button>
          <button
            type="button"
            onClick={() => onDelete(node)}
            className="invisible mr-2 font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:text-[#f0a0a0] group-hover:visible"
            title={`delete ${node.path} and everything inside`}
          >
            ×
          </button>
        </div>
        {open ? (
          <ul>
            {(node.children ?? []).map((child) => (
              <TreeEntry
                key={child.path}
                node={child}
                depth={depth + 1}
                activePath={activePath}
                onSelect={onSelect}
                onDelete={onDelete}
              />
            ))}
          </ul>
        ) : null}
      </li>
    );
  }
  return (
    <li className="group flex items-center justify-between">
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        className={[
          'flex-1 truncate py-1 text-left font-mono text-[11px]',
          isActive ? 'text-soft-white' : 'text-slate-gray hover:text-soft-white',
        ].join(' ')}
        style={{ paddingLeft: padLeft + 18, paddingRight: 6 }}
        title={node.path}
      >
        {node.name}
        {pinned ? <span className="ml-2 text-[10px] text-slate-gray">pinned</span> : null}
      </button>
      {!pinned ? (
        <button
          type="button"
          onClick={() => onDelete(node)}
          className="invisible mr-2 font-mono text-[10px] uppercase tracking-wider text-slate-gray hover:text-[#f0a0a0] group-hover:visible"
          title={`delete ${node.path}`}
        >
          ×
        </button>
      ) : null}
    </li>
  );
}
