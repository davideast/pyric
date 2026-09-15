import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { resolveWorkspacePath } from './studio/disk-workspace.js';
import { readThresholdConfig, type ThresholdConfig } from './runtime/rate-threshold-config.js';

/** Only pyric.json is writable; preserve unrelated settings and reject stale edits. */
export function createThresholdConfigStore(projectDir: string) {
  const root = resolve(projectDir);
  let queue = Promise.resolve();
  async function document() {
    let contents: string | null = null;
    try { contents = await readFile(resolveWorkspacePath(root, 'pyric.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const value = contents === null ? {} : JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pyric.json must contain an object.');
    if (value.runtime !== undefined && (!value.runtime || typeof value.runtime !== 'object' || Array.isArray(value.runtime))) throw new Error('pyric.json runtime must contain an object.');
    const config = readThresholdConfig(value.runtime?.thresholds);
    const revision = createHash('sha256').update(JSON.stringify(contents)).digest('hex');
    return { value, config, revision };
  }
  async function read() { const { config, revision } = await document(); return { config, revision }; }
  function save(config: ThresholdConfig, revision: string) {
    const validated = readThresholdConfig(config);
    const action = queue.then(async () => {
      const current = await document();
      if (revision !== current.revision) throw new Error('pyric.json changed. Reopen Thresholds before saving.');
      const next = { ...current.value, runtime: { ...current.value.runtime, thresholds: validated } };
      const path = resolveWorkspacePath(root, 'pyric.json');
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx' });
        if ((await document()).revision !== revision) throw new Error('pyric.json changed. Reopen Thresholds before saving.');
        await rename(temporary, resolveWorkspacePath(root, 'pyric.json'));
      } finally { await rm(temporary, { force: true }); }
      return read();
    });
    queue = action.then(() => {}, () => {});
    return action;
  }
  return { read, save };
}
export type ThresholdConfigStore = ReturnType<typeof createThresholdConfigStore>;
