/**
 * `work-list.json`: the items the lead plans and the builders take. The
 * sessions write it; the supervisor only reads it, to know whether a builder
 * has work and whether a builder has marked work ready.
 *
 *   { "items": [{ "id": "login-form", "title": "...", "status": "todo" }] }
 *
 * A builder sets `owner` to its seat when it takes an item and `ready` when
 * the item is built. Sessions write it through a temporary file and a
 * rename. A missing list is empty, so the lead plans one. A list that exists
 * but doesn't parse is unreadable, not empty: it may be half written, and the
 * supervisor keeps the last list it read (`work-list-reader.ts`).
 */
import { lstatSync } from 'node:fs';
import { z } from 'zod';
import { parseJsonText, parseWith } from '../parse.ts';
import { readRunFile } from './host-files.ts';

const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(['todo', 'in-progress', 'ready', 'done']),
  /** The builder seat working on it. */
  owner: z.string().optional(),
}).passthrough();

const workListSchema = z.object({ items: z.array(itemSchema) }).passthrough();

export type WorkItem = z.infer<typeof itemSchema>;

export type WorkListRead = { ok: true; items: WorkItem[] } | { ok: false; errors: string[] };

export function readWorkList(path: string): WorkListRead {
  const isMissing = lstatSync(path, { throwIfNoEntry: false }) === undefined;
  if (isMissing) return { ok: true, items: [] };
  // Sessions write it, so it is read never through a link (`host-files.ts`).
  const read = readRunFile(path);
  if (!read.ok) return { ok: false, errors: [`refusing to read it: ${read.problem}`] };
  const text = parseJsonText(read.text);
  const parsed = text.ok ? parseWith(workListSchema, text.value) : text;
  return parsed.ok ? { ok: true, items: parsed.value.items } : parsed;
}

/** A todo item anyone may take, or an item this seat already took. */
export function hasWorkFor(items: readonly WorkItem[], seat: string): boolean {
  return items.some((item) => {
    const isOpen = item.status === 'todo' && item.owner === undefined;
    const isOwnUnfinished = item.owner === seat && (item.status === 'todo' || item.status === 'in-progress');
    return isOpen || isOwnUnfinished;
  });
}

export function readyIds(items: readonly WorkItem[]): string[] {
  return items.filter((item) => item.status === 'ready').map((item) => item.id);
}
