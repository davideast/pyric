/**
 * Tier 1 proof: the REAL workspace file tools (write_file / edit_file /
 * search_file / read_file / list_files / delete_file) run headlessly in Node, end to end, through the
 * in-memory VFS — no browser, no OPFS. This is the thing that was blocked
 * before: the tools went straight to `navigator.storage.getDirectory()`.
 *
 * The tools pull in the workspace/files stores, which touch
 * `window.localStorage`. Node has neither, so we polyfill before the tool
 * chain loads (dynamic import in beforeAll, after the polyfill runs).
 */
import { describe, test, expect, beforeAll } from 'bun:test';
import type { ToolHandler } from '@inbrowser/agent';

if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: () => null,
      get length() {
        return store.size;
      },
    },
  };
}

const ctx = {} as never; // file tools don't read ToolContext
let writeFile: ToolHandler;
let editFile: ToolHandler;
let searchFile: ToolHandler;
let readFile: ToolHandler;
let listFiles: ToolHandler;
let deleteFile: ToolHandler;
let resetVFS: () => void;

beforeAll(async () => {
  writeFile = (await import('~/lib/tools/core/writeFile')).writeFileHandler as ToolHandler;
  editFile = (await import('~/lib/tools/core/editFile')).editFileHandler as ToolHandler;
  searchFile = (await import('~/lib/tools/core/searchFile')).searchFileHandler as ToolHandler;
  readFile = (await import('~/lib/tools/core/readFile')).readFileHandler as ToolHandler;
  listFiles = (await import('~/lib/tools/core/listFiles')).listFilesHandler as ToolHandler;
  deleteFile = (await import('~/lib/tools/core/deleteFile')).deleteFileHandler as ToolHandler;
  resetVFS = (await import('~/lib/vfs')).resetVFS;
});

describe('workspace file tools run headlessly', () => {
  test('write_file then read_file round-trips the App TSX', async () => {
    resetVFS();
    const src = 'export default function App() { return null; }';
    const w = await writeFile.execute({ path: '/workspace/src/App.tsx', content: src }, ctx);
    expect(w.ok).toBe(true);
    const r = await readFile.execute({ path: '/workspace/src/App.tsx' }, ctx);
    expect(r.ok).toBe(true);
    expect((r.data as { content: string }).content).toBe(src);
  });

  test('write_file then read_file round-trips the rules file', async () => {
    resetVFS();
    const rules = "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { allow read; } }";
    await writeFile.execute({ path: '/workspace/firestore.rules', content: rules }, ctx);
    const r = await readFile.execute({ path: '/workspace/firestore.rules' }, ctx);
    expect((r.data as { content: string }).content).toContain('service cloud.firestore');
  });

  test('list_files enumerates everything write_file created', async () => {
    resetVFS();
    await writeFile.execute({ path: '/workspace/firestore.rules', content: "rules_version='2';" }, ctx);
    await writeFile.execute({ path: '/workspace/src/App.tsx', content: 'x' }, ctx);
    const l = await listFiles.execute({}, ctx);
    const files = (l.data as { files: string[] }).files;
    expect(files).toContain('/workspace/firestore.rules');
    expect(files).toContain('/workspace/src/App.tsx');
  });

  test('delete_file removes a scratch file but refuses the pinned rules file', async () => {
    resetVFS();
    await writeFile.execute({ path: '/workspace/scratch.ts', content: 'x' }, ctx);
    const d = await deleteFile.execute({ path: '/workspace/scratch.ts' }, ctx);
    expect((d.data as { deleted: boolean }).deleted).toBe(true);
    const pinned = await deleteFile.execute({ path: '/workspace/firestore.rules' }, ctx);
    expect((pinned.data as { deleted: boolean; reason?: string }).deleted).toBe(false);
    expect((pinned.data as { reason?: string }).reason).toBe('PINNED');
  });

  test('read_file on a missing path surfaces a not-found-style failure, not a crash', async () => {
    resetVFS();
    // The OPFS path threw on navigator.storage; here it must reach the
    // tool's own ENOENT handling instead of blowing up on a missing API.
    await expect(readFile.execute({ path: '/workspace/missing.ts' }, ctx)).rejects.toBeDefined();
  });

  test('read_file supports line ranges and caps large unranged reads by default', async () => {
    resetVFS();
    const content = Array.from({ length: 600 }, (_, i) => `line ${i + 1}: ${'x'.repeat(30)}`).join('\n');
    await writeFile.execute({ path: '/workspace/large.txt', content }, ctx);

    const ranged = await readFile.execute({ path: '/workspace/large.txt', startLine: 10, endLine: 12 }, ctx);
    expect((ranged.data as { content: string; startLine: number; endLine: number }).content).toBe([
      `line 10: ${'x'.repeat(30)}`,
      `line 11: ${'x'.repeat(30)}`,
      `line 12: ${'x'.repeat(30)}`,
    ].join('\n'));
    expect((ranged.data as { startLine: number; endLine: number }).startLine).toBe(10);
    expect((ranged.data as { startLine: number; endLine: number }).endLine).toBe(12);

    const capped = await readFile.execute({ path: '/workspace/large.txt' }, ctx);
    expect((capped.data as { truncated?: boolean }).truncated).toBe(true);
    expect((capped.data as { content: string }).content.length).toBeLessThan(content.length);

    const full = await readFile.execute({ path: '/workspace/large.txt', full: true }, ctx);
    expect((full.data as { content: string; truncated?: boolean }).content).toBe(content);
    expect((full.data as { truncated?: boolean }).truncated).toBeUndefined();
  });

  test('search_file returns compact line-numbered snippets', async () => {
    resetVFS();
    await writeFile.execute({
      path: '/workspace/src/App.tsx',
      content: ['alpha', 'function App() {', '  return <div>App</div>;', '}', 'omega'].join('\n'),
    }, ctx);
    const res = await searchFile.execute({ path: '/workspace/src/App.tsx', query: 'app', contextLines: 1 }, ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { totalMatches: number; matches: Array<{ line: number; before: unknown[]; after: unknown[] }> };
    expect(data.totalMatches).toBe(2);
    expect(data.matches[0]!.line).toBe(2);
    expect(data.matches[0]!.before).toHaveLength(1);
    expect(data.matches[0]!.after).toHaveLength(1);
  });

  test('edit_file rejects missing or ambiguous edits unless replaceAll is true', async () => {
    resetVFS();
    await writeFile.execute({ path: '/workspace/notes.txt', content: 'a\na\nb\n' }, ctx);

    const missing = await editFile.execute({
      path: '/workspace/notes.txt',
      edits: [{ oldText: 'z', newText: 'q' }],
    }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.summary).toContain('oldText not found');

    const ambiguous = await editFile.execute({
      path: '/workspace/notes.txt',
      edits: [{ oldText: 'a', newText: 'x' }],
    }, ctx);
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.summary).toContain('ambiguous');

    const replaced = await editFile.execute({
      path: '/workspace/notes.txt',
      edits: [{ oldText: 'a', newText: 'x', replaceAll: true }],
    }, ctx);
    expect(replaced.ok).toBe(true);
    const r = await readFile.execute({ path: '/workspace/notes.txt', full: true }, ctx);
    expect((r.data as { content: string }).content).toBe('x\nx\nb\n');
  });

  test('edit_file commits through the write_file validation path for rules edits', async () => {
    resetVFS();
    const before = "rules_version = '2';\nservice cloud.firestore { match /databases/{d}/documents { match /pub/{id} { allow read: if true; } } }";
    await writeFile.execute({ path: '/workspace/firestore.rules', content: before }, ctx);
    const edited = await editFile.execute({
      path: '/workspace/firestore.rules',
      edits: [{ oldText: 'allow read: if true;', newText: 'allow read: if false;' }],
    }, ctx);
    expect(edited.ok).toBe(true);
    expect(edited.summary).toContain('edit_file');
    expect((edited.data as { validation?: unknown }).validation).toBeDefined();
  });
});
