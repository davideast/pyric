import {
  createMemoryFileSystem,
  createOPFSFileSystem,
  createScopedFileSystem,
  normalizePath,
  opfsAvailable,
} from '@inbrowser/workspace/fs';
import { createPackageRegistry } from '@inbrowser/workspace/packages';
import { createWorkspaceSnapshotManager } from '@inbrowser/workspace/snapshots';
import type { BrowserWorkspace, BrowserWorkspaceOptions } from '@inbrowser/workspace';

/**
 * Browser-only workspace entry. The package barrel also exports its shell
 * adapter, which is useful in Node but causes Vite to bundle just-bash for
 * the browser. Keep shell/git lazy and out of the application bundle.
 */
export async function createBrowserWorkspace(options: BrowserWorkspaceOptions): Promise<BrowserWorkspace> {
  const root = normalizePath(options.root ?? '/work');
  const storage = options.storage ?? 'opfs-with-memory-fallback';
  const shouldUseOpfs = storage !== 'memory' && opfsAvailable();
  if (storage === 'opfs' && !shouldUseOpfs) throw new Error('OPFS is not available in this browser context.');

  const storageFs = shouldUseOpfs ? createOPFSFileSystem({ root: '/' }) : createMemoryFileSystem({ root: '/' });
  const fs = createScopedFileSystem(storageFs, {
    virtualRoot: root,
    realRoot: `${workspaceStorageRoot(options.id)}${root}`,
  });
  await fs.promises.mkdir(root, { recursive: true });
  const packages = createPackageRegistry({ fs });
  const snapshots = createWorkspaceSnapshotManager({
    workspaceFs: fs,
    metadataFs: storageFs,
    root,
    storageRoot: `${workspaceStorageRoot(options.id)}/metadata`,
  });

  return {
    id: options.id,
    root,
    storageStatus: shouldUseOpfs ? 'best-effort' : 'memory',
    fs,
    packages,
    snapshots,
    async createReactPreview(previewOptions) {
      const { createReactPreviewRuntime } = await import('@inbrowser/workspace/preview/react');
      return createReactPreviewRuntime({ ...previewOptions, fs, importMap: previewOptions.importMap });
    },
    async createShell(shellOptions = {}) {
      void shellOptions;
      throw new Error('Shell tools are not enabled in the browser preview.');
    },
    async createGit(gitOptions = {}) {
      void gitOptions;
      throw new Error('Git tools are not enabled in the browser preview.');
    },
    dispose() {},
  };
}

function workspaceStorageRoot(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+$/, '_');
  return `/.inbrowser/workspaces/${safe}`;
}
