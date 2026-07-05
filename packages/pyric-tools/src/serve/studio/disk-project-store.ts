/**
 * `diskProjectStore(root)` — a {@link ProjectStore} where each project is a
 * subdirectory of `root` carrying a small metadata file (`.pyric-project.json`,
 * shape {@link ProjectMeta}). `open(id)` hands back a {@link ProjectHandle}
 * whose `workspace` is a {@link diskWorkspace} rooted at that subdirectory.
 *
 * Project ids ARE the directory names; they're slugged from the title (or
 * generated) and validated to a safe charset so an id can never traverse out of
 * `root`. The metadata file lives alongside the project's working tree — it's
 * skipped by `diskWorkspace.list` callers only by convention (the file tree
 * shows it; that's acceptable for a `.pyric-*` dotfile).
 */
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { diskWorkspace } from './disk-workspace.js';
import type {
  ProjectHandle,
  ProjectMeta,
  ProjectStore,
} from './store-types.js';

const META_FILE = '.pyric-project.json';

/** Thrown when an id isn't a safe single path segment. */
export class ProjectIdError extends Error {
  constructor(id: string) {
    super(`invalid project id: '${id}'`);
    this.name = 'ProjectIdError';
  }
}

/** Slug a title into a filesystem-safe id segment. */
export function slugifyProjectId(title: string): string {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug;
}

/** A safe id is a single non-dot path segment of `[a-z0-9-_]`. */
function assertSafeId(id: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || id.includes('/') || id.includes('..')) {
    throw new ProjectIdError(id);
  }
}

export function diskProjectStore(rootDir: string): ProjectStore {
  const root = resolve(rootDir);

  function projectDir(id: string): string {
    assertSafeId(id);
    return join(root, id);
  }

  async function readMeta(id: string): Promise<ProjectMeta | null> {
    try {
      const raw = await readFile(join(projectDir(id), META_FILE), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProjectMeta>;
      const now = Date.now();
      return {
        id,
        title: typeof parsed.title === 'string' ? parsed.title : id,
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : now,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : now,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  async function writeMeta(meta: ProjectMeta): Promise<void> {
    const dir = projectDir(meta.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, META_FILE),
      JSON.stringify(meta, null, 2) + '\n',
      'utf8',
    );
  }

  return {
    async list() {
      let names: string[];
      try {
        names = await readdir(root);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw e;
      }
      const metas: ProjectMeta[] = [];
      for (const name of names) {
        if (name.startsWith('.')) continue;
        let isDir = false;
        try {
          isDir = (await stat(join(root, name))).isDirectory();
        } catch {
          continue;
        }
        if (!isDir) continue;
        try {
          const meta = await readMeta(name);
          // A directory without a meta file is still a project — synthesize.
          metas.push(
            meta ?? {
              id: name,
              title: name,
              createdAt: 0,
              updatedAt: 0,
            },
          );
        } catch (e) {
          if (e instanceof ProjectIdError) continue; // not a valid project dir
          throw e;
        }
      }
      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      return metas;
    },

    async open(id) {
      const dir = projectDir(id);
      let meta = await readMeta(id);
      if (meta === null) {
        // Allow opening a bare directory that exists but lacks metadata.
        try {
          if ((await stat(dir)).isDirectory()) {
            meta = { id, title: id, createdAt: Date.now(), updatedAt: Date.now() };
          }
        } catch {
          /* fall through to throw */
        }
      }
      if (meta === null) {
        throw new Error(`project not found: '${id}'`);
      }
      const handle: ProjectHandle = {
        meta,
        workspace: diskWorkspace(dir),
      };
      return handle;
    },

    async create(input) {
      const title = input.title?.trim() || 'untitled';
      const base = slugifyProjectId(title) || 'project';
      // Disambiguate against existing dirs.
      let id = base;
      let n = 1;
      while (true) {
        try {
          await stat(join(root, id));
          id = `${base}-${++n}`;
        } catch {
          break; // free
        }
      }
      const now = Date.now();
      const meta: ProjectMeta = { id, title, createdAt: now, updatedAt: now };
      await writeMeta(meta);
      return meta;
    },

    async update(id, patch) {
      const existing = await readMeta(id);
      if (existing === null) throw new Error(`project not found: '${id}'`);
      const next: ProjectMeta = {
        ...existing,
        ...patch,
        id, // id is immutable
        updatedAt: Date.now(),
      };
      await writeMeta(next);
    },

    async remove(id) {
      const dir = projectDir(id);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
