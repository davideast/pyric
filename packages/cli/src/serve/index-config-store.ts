import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, rename, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { analyzeIndexQuery, readIndexConfig, type IndexQuery } from 'pyric/sandbox/internal';
import { resolveWorkspacePath } from './studio/disk-workspace.js';

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** The existing Firebase config selects the only writable file. No path comes from the browser. */
export function createIndexConfigStore(projectDir: string) {
  const root = resolve(projectDir);
  let queue = Promise.resolve();
  async function read() {
    const firebase = await readOptional(resolveWorkspacePath(root, 'firebase.json'));
    if (firebase === null) throw new Error('Add an indexes path to firebase.json to connect local index configuration.');
    const setup = JSON.parse(firebase);
    if (Array.isArray(setup.firestore)) throw new Error('Select a single Firestore database configuration before editing indexes here.');
    const path: unknown = setup.firestore?.indexes;
    if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('Set firestore.indexes in firebase.json to a project-relative file.');
    const absolute = resolveWorkspacePath(root, path);
    const contents = await readOptional(absolute);
    const config = readIndexConfig(contents === null ? { indexes: [], fieldOverrides: [] } : JSON.parse(contents));
    const revision = createHash('sha256').update(JSON.stringify([firebase, contents])).digest('hex');
    return { path, config, revision };
  }
  async function preview(query: IndexQuery) {
    const current = await read();
    const finding = analyzeIndexQuery(query, current.config);
    if (finding.status !== 'missing') return { ...current, finding, addition: null };
    return { ...current, finding, addition: finding.index };
  }
  function apply(query: IndexQuery, revision: string) {
    const action = queue.then(async () => {
      const current = await preview(query);
      if (current.revision !== revision) throw new Error('The index configuration changed. Preview the change again.');
      if (!current.addition) return current;
      const absolute = resolveWorkspacePath(root, current.path);
      await mkdir(dirname(absolute), { recursive: true });
      const temporary = `${absolute}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ ...current.config, indexes: [...current.config.indexes, current.addition] }, null, 2)}\n`, { flag: 'wx' });
        // Detect edits made while the preview was being prepared or written.
        if ((await read()).revision !== revision) throw new Error('The index configuration changed. Preview the change again.');
        await rename(temporary, resolveWorkspacePath(root, current.path));
      } finally { await rm(temporary, { force: true }); }
      return preview(query);
    });
    queue = action.then(() => {}, () => {});
    return action;
  }
  return { read, preview, apply };
}
export type IndexConfigStore = ReturnType<typeof createIndexConfigStore>;
