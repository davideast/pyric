/**
 * File-selection state for the workspace. One file is "active" at a
 * time — the FileEditor reads from it, the FilesPanel highlights it.
 *
 * Path conventions:
 *   - Every path is absolute under the OPFS VFS.
 *   - `/workspace/firestore.rules` is the rules file.
 *   - `/workspace/src/App.tsx` is the App preview entry.
 *   - Any other file under `/workspace/` is user-owned and freely editable.
 *
 * `pinnedPaths` lists paths the FilesPanel must not allow deleting.
 * `firestore.rules` lives there because Firestore rules deployment
 * targets a file at a known location — losing it would break the
 * deploy/rules-lint loop.
 */
import { create } from 'zustand';

export const WORKSPACE_ROOT = '/workspace';
export const RULES_PATH = '/workspace/firestore.rules';
export const APP_ENTRY_PATH = '/workspace/src/App.tsx';

export const PINNED_PATHS: readonly string[] = [RULES_PATH];

interface FilesState {
  activeFilePath: string | null;
  setActiveFilePath: (path: string | null) => void;
  /** Bump whenever a file is created / deleted / renamed so the
   *  FilesPanel re-reads the tree. Avoids snapshotting the tree in
   *  this store — the tree lives in OPFS and we walk it on demand. */
  treeVersion: number;
  bumpTree: () => void;
  /** Bump whenever anything under /workspace/src/ changes. The app
   *  preview recompiles on this — esbuild reads IMPORTED files fresh
   *  from the VFS at compile time, so an edit to
   *  /workspace/src/components/Foo.tsx must recompile even though
   *  `appSource` (App.tsx only) is unchanged. The historical stale-
   *  preview bug was recompile keying on the appSource string alone. */
  srcVersion: number;
  bumpSrc: () => void;
}

export const useFilesStore = create<FilesState>()((set) => ({
  activeFilePath: APP_ENTRY_PATH,
  setActiveFilePath: (activeFilePath) => set({ activeFilePath }),
  treeVersion: 0,
  bumpTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),
  srcVersion: 0,
  bumpSrc: () => set((s) => ({ srcVersion: s.srcVersion + 1 })),
}));

export function isPinned(path: string): boolean {
  return PINNED_PATHS.includes(path);
}
