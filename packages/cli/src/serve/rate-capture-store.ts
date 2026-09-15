import { isThresholdService, type ThresholdService } from './runtime/rate-threshold-config.js';
/** Project-owned investigation snapshots, separate from the live session fixture. */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, realpath, lstat, link, unlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readRateCapture } from './runtime/rate-capture.js';

export interface CaptureEntry {
  id: string;
  name: string | null;
  service: ThresholdService;
  savedAt: string;
  from: number;
  duration: number;
  incident: string | null;
}
const idPattern = /^[0-9a-f-]{36}$/;
const maxBytes = 32 * 1024 * 1024;
export function createRateCaptureStore(projectDir: string) {
  const directory = resolve(projectDir, '.pyric/captures');
  async function folder(create = false) {
    // Refuse redirected project storage, including symlinked ancestors.
    const root = await realpath(projectDir);
    for (const part of ['.pyric', '.pyric/captures']) {
      const path = join(root, part);
      if (create) await mkdir(path, { recursive: true });
      if ((await lstat(path)).isSymbolicLink() || await realpath(path) !== path) throw new Error('Capture storage must remain inside the project.');
    }
    return join(root, '.pyric/captures');
  }
  function metadata(id: string, text: string, savedAt: string): CaptureEntry {
    const { frame } = readRateCapture(text);
    if (!isThresholdService(frame.service.service)) throw new Error('Unsupported capture service.');
    return { id, name: null, service: frame.service.service, savedAt, from: frame.clockOffset + frame.from * 1000, duration: frame.duration, incident: frame.incident?.label ?? null };
  }
  async function read(id: string) {
    if (!idPattern.test(id)) throw new Error('Invalid capture id.');
    const path = join(await folder(), `${id}.json`);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid capture file.');
    const text = await readFile(path, 'utf8');
    readRateCapture(text);
    return text;
  }
  function captureName(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Use a name of up to 80 characters on one line.');
    return value.trim() || null;
  }
  async function readName(dir: string, id: string): Promise<string | null> {
    try {
      const path = join(dir, `${id}.metadata.json`);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
      const data = JSON.parse(await readFile(path, 'utf8'));
      return data.name === null ? null : captureName(data.name);
    } catch { return null; }
  }
  return {
    directory,
    async save(text: string): Promise<CaptureEntry> {
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('Capture exceeds 32 MB.');
      const id = randomUUID();
      const entry = metadata(id, text, new Date().toISOString());
      const dir = await folder(true);
      const temporary = join(dir, `${id}.tmp`);
      try {
        await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
        await link(temporary, join(dir, `${id}.json`));
      } finally { await unlink(temporary).catch(() => {}); }
      return entry;
    },
    read,
    async rename(id: string, name: string): Promise<CaptureEntry> {
      const normalized = captureName(name);
      const text = await read(id);
      const dir = await folder();
      const temporary = join(dir, `${id}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify({ name: normalized }), { flag: 'wx', mode: 0o600 });
        await rename(temporary, join(dir, `${id}.metadata.json`));
      } finally { await unlink(temporary).catch(() => {}); }
      const stat = await lstat(join(dir, `${id}.json`));
      return { ...metadata(id, text, stat.mtime.toISOString()), name: normalized };
    },
    async remove(id: string): Promise<void> {
      await read(id);
      const dir = await folder();
      await unlink(join(dir, `${id}.json`));
      await unlink(join(dir, `${id}.metadata.json`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    },
    async list(): Promise<CaptureEntry[]> {
      let dir: string;
      try { dir = await folder(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
      const entries: CaptureEntry[] = [];
      for (const name of await readdir(dir)) {
        const id = name.replace(/\.json$/, '');
        if (!name.endsWith('.json') || !idPattern.test(id)) continue;
        try {
          const text = await read(id);
          const stat = await lstat(join(dir, name));
          entries.push({ ...metadata(id, text, stat.mtime.toISOString()), name: await readName(dir, id) });
        } catch { /* A corrupt or foreign file is not an openable capture. */ }
      }
      return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || a.id.localeCompare(b.id));
    },
  };
}
export type RateCaptureStore = ReturnType<typeof createRateCaptureStore>;
