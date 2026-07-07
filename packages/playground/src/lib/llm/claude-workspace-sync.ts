/**
 * Browser ⇄ server workspace sync for the Claude lane's MCP bridge
 * mode (seam A — server-hosted session; the browser is the viewer).
 *
 * A tools turn on the Claude lane runs `claude -p` against a SERVER
 * workspace (`~/lib/server/claude-mcp.ts`), not the browser's OPFS
 * VFS. So the provider wrapper:
 *   1. `pushWorkspaceToBridge()` BEFORE the turn — Claude starts from
 *      exactly what the user sees;
 *   2. `pullWorkspaceFromBridge()` AFTER the turn — Claude's writes/
 *      deletes land in the browser VFS, the files panel, and the
 *      rules/App store mirrors (preview refresh included).
 *
 * Deletions are applied on pull: the server was seeded from the
 * browser at turn start, so a path missing afterwards is a file
 * Claude deleted. Both directions fail LOUD — a half-synced turn is
 * worse than an error the user can retry.
 */
import { listAllFiles } from '~/lib/files/file-tree';
import { notifyVfsWrite } from '~/lib/files/bootstrap';
import { useFilesStore, WORKSPACE_ROOT } from '~/lib/store/files';
import { getVFS } from '~/lib/vfs';

export const WORKSPACE_SYNC_PATH = '/api/claude-mcp/workspace';

interface WorkspaceFileEntry {
  path: string;
  content: string;
}

async function readUtf8(path: string): Promise<string | null> {
  try {
    const raw = await getVFS().promises.readFile(path, 'utf8');
    return typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch {
    return null;
  }
}

/** Browser → server: seed the bridge workspace for the coming turn. */
export async function pushWorkspaceToBridge(): Promise<void> {
  const paths = await listAllFiles(WORKSPACE_ROOT).catch(() => [] as string[]);
  const files: WorkspaceFileEntry[] = [];
  for (const path of paths) {
    const content = await readUtf8(path);
    if (content !== null) files.push({ path, content });
  }
  const res = await fetch(WORKSPACE_SYNC_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) {
    throw new Error(
      `Claude MCP bridge: workspace push failed (HTTP ${res.status}). ` +
        'The tools turn was not started — is the dev server healthy?',
    );
  }
}

/** Server → browser: apply the post-turn workspace (writes + deletes). */
export async function pullWorkspaceFromBridge(): Promise<void> {
  const res = await fetch(WORKSPACE_SYNC_PATH);
  if (!res.ok) {
    throw new Error(
      `Claude MCP bridge: workspace pull failed (HTTP ${res.status}). ` +
        "The turn completed on the server, but its file changes couldn't be fetched — retry the request.",
    );
  }
  const snapshot = (await res.json()) as { files?: WorkspaceFileEntry[] };
  const files = Array.isArray(snapshot.files) ? snapshot.files : [];

  const vfs = getVFS();
  const serverPaths = new Set(files.map((f) => f.path));
  const browserPaths = await listAllFiles(WORKSPACE_ROOT).catch(() => [] as string[]);

  let changed = false;
  for (const path of browserPaths) {
    if (!serverPaths.has(path)) {
      await vfs.promises.unlink(path).catch(() => {});
      changed = true;
    }
  }
  for (const { path, content } of files) {
    if (!path.startsWith(`${WORKSPACE_ROOT}/`)) continue;
    const existing = await readUtf8(path);
    if (existing === content) continue;
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) await vfs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    await vfs.promises.writeFile(path, content);
    notifyVfsWrite(path, content); // store mirrors (rules/App) + tree bump
    changed = true;
  }
  if (changed) useFilesStore.getState().bumpTree();
}
