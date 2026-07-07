/**
 * On first load, seed the OPFS VFS with the two files the workspace
 * store has been holding in memory — rules + App TSX — so the new
 * file-centric UI has something to show. Idempotent: if the files
 * already exist (subsequent reloads), the seed is a no-op.
 *
 * Also installs a write-back mirror: any subsequent write to
 * `/workspace/firestore.rules` updates `workspaceStore.rules`, and
 * any write to `/workspace/src/App.tsx` updates `workspaceStore.appSource`.
 * That keeps the existing compile/deploy pipeline working without
 * rewriting it yet (Phase C swaps the read direction).
 */
import { useWorkspaceStore } from '~/lib/store/workspace';
import { APP_ENTRY_PATH, DATABASE_RULES_PATH, RULES_PATH, useFilesStore } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

let bootstrapPromise: Promise<void> | null = null;
let mirrorInstalled = false;

const SRC_DIR = '/workspace/src';

async function fileExists(path: string): Promise<boolean> {
  const adapter = getVFS();
  try {
    await adapter.promises.lstat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function seedFile(path: string, content: string): Promise<void> {
  const adapter = getVFS();
  if (await fileExists(path)) return;
  if (path.startsWith(`${SRC_DIR}/`)) {
    await adapter.promises.mkdir(SRC_DIR, { recursive: true });
  }
  await adapter.promises.writeFile(path, content);
}

/** Idempotent. Safe to call from any component mount. */
export function bootstrapWorkspaceFiles(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    const ws = useWorkspaceStore.getState();
    await seedFile(RULES_PATH, ws.rules ?? '');
    await seedFile(DATABASE_RULES_PATH, ws.databaseRules ?? '');
    await seedFile(APP_ENTRY_PATH, ws.appSource ?? '');
    useFilesStore.getState().bumpTree();
    installWriteMirror();
  })();
  return bootstrapPromise;
}

/**
 * Install the mirror that pushes VFS edits of the two known files
 * back into the workspace store. Wired through the file tools +
 * FileEditor — whichever path produces a write calls
 * `notifyVfsWrite(path)`.
 */
function installWriteMirror(): void {
  if (mirrorInstalled) return;
  mirrorInstalled = true;
}

const mirrorRoutes: Record<string, (content: string) => void> = {
  [RULES_PATH]: (content) => useWorkspaceStore.getState().setRules(content),
  [DATABASE_RULES_PATH]: (content) => useWorkspaceStore.getState().setDatabaseRules(content),
  [APP_ENTRY_PATH]: (content) => useWorkspaceStore.getState().setAppSource(content),
};

/**
 * Call after every VFS write to a file under `/workspace/` so the
 * legacy store + downstream listeners (compile, deploy, lint strip)
 * see the change. Cheap fast-path: only the two known files trigger
 * real work; any write under /workspace/src/ additionally bumps
 * `srcVersion` so the preview recompiles (imported files are read
 * fresh from the VFS at compile time — see store/files.ts).
 */
export function notifyVfsWrite(path: string, content: string): void {
  const route = mirrorRoutes[path];
  if (route) route(content);
  const files = useFilesStore.getState();
  files.bumpTree();
  if (path.startsWith(`${SRC_DIR}/`)) files.bumpSrc();
}

/**
 * Call after a VFS mutation WITHOUT new content in hand (delete,
 * rename, `rm`/`mv` from the shell). Re-reads a mirrored path from
 * the VFS when it was the one touched (missing file mirrors as '');
 * always bumps the tree, and src when applicable.
 */
export function notifyVfsPathChanged(path: string): void {
  const route = mirrorRoutes[path];
  if (route) {
    try {
      void getVFS()
        .promises.readFile(path, 'utf8')
        .then((v) => route(typeof v === 'string' ? v : new TextDecoder().decode(v)))
        .catch(() => route(''));
    } catch {
      // Headless context without a VFS (unit tests) — mirror skipped.
    }
  }
  const files = useFilesStore.getState();
  files.bumpTree();
  if (path.startsWith(`${SRC_DIR}/`)) files.bumpSrc();
}

/**
 * Re-sync the whole mirror from the VFS after a BULK working-tree
 * mutation (checkpoint rollback, git checkout/restore) where per-file
 * notifications aren't practical. Re-reads both well-known files and
 * bumps every version counter, so rules redeploy and the preview
 * recompiles against the restored tree.
 */
export async function resyncWorkspaceMirror(): Promise<void> {
  const adapter = getVFS();
  const readOrEmpty = async (path: string): Promise<string> => {
    try {
      const v = await adapter.promises.readFile(path, 'utf8');
      return typeof v === 'string' ? v : new TextDecoder().decode(v);
    } catch {
      return '';
    }
  };
  const [rules, databaseRules, appSource] = await Promise.all([
    readOrEmpty(RULES_PATH),
    readOrEmpty(DATABASE_RULES_PATH),
    readOrEmpty(APP_ENTRY_PATH),
  ]);
  mirrorRoutes[RULES_PATH]!(rules);
  mirrorRoutes[DATABASE_RULES_PATH]!(databaseRules);
  mirrorRoutes[APP_ENTRY_PATH]!(appSource);
  const files = useFilesStore.getState();
  files.bumpTree();
  files.bumpSrc();
}
