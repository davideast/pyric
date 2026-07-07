/**
 * Recursive walk over the OPFS VFS, returning a sorted tree shape
 * the FilesPanel can render directly. Directories come before files
 * at each level; names are case-insensitive sorted.
 */
import { getVFS } from '~/lib/vfs';

export interface TreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: TreeNode[];
}

export async function listTree(root: string): Promise<TreeNode> {
  const adapter = getVFS();
  const stat = await adapter.promises.lstat(root).catch(() => null);
  const baseName = root === '/' ? '/' : root.split('/').filter(Boolean).pop() ?? '/';
  if (!stat) {
    return { name: baseName, path: root, type: 'dir', children: [] };
  }
  if (!stat.isDirectory()) {
    return { name: baseName, path: root, type: 'file' };
  }
  const names = await adapter.promises.readdir(root).catch(() => [] as string[]);
  const children: TreeNode[] = [];
  for (const name of names) {
    const childPath = root.endsWith('/') ? `${root}${name}` : `${root}/${name}`;
    const childStat = await adapter.promises.lstat(childPath).catch(() => null);
    if (!childStat) continue;
    if (childStat.isDirectory()) {
      children.push(await listTree(childPath));
    } else {
      children.push({ name, path: childPath, type: 'file' });
    }
  }
  children.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return { name: baseName, path: root, type: 'dir', children };
}

/** Flat list of all file paths under `root`. */
export async function listAllFiles(root: string): Promise<string[]> {
  const tree = await listTree(root);
  const out: string[] = [];
  const walk = (node: TreeNode) => {
    if (node.type === 'file') {
      out.push(node.path);
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return out;
}
