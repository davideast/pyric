/**
 * `work-list.json`: the items the lead plans and the builders take. The
 * sessions write it; the supervisor only reads it, to know whether a builder
 * has work and whether a builder has marked work ready.
 *
 *   { "items": [{ "id": "login-form", "title": "...", "status": "todo" }] }
 *
 * A builder sets `owner` to its seat when it takes an item and `ready` when
 * the item is built. An item with `blocked` set is no builder's work.
 * Sessions write it through a temporary file and a
 * rename. A missing list is empty, so the lead plans one. A list that exists
 * but doesn't parse is unreadable, not empty: it may be half written, and the
 * supervisor keeps the last list it read (`work-list-reader.ts`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseJsonText, parseWith } from '../parse.ts';

const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  status: z.enum(['todo', 'in-progress', 'ready', 'done']),
  /** The builder seat working on it. */
  owner: z.string().optional(),
  /** Why no builder can go on with it: the issue draft that blocks it. Any value but `false` or `""` blocks. */
  blocked: z.unknown().optional(),
}).passthrough();

const workListSchema = z.object({ items: z.array(itemSchema) }).passthrough();

export type WorkItem = z.infer<typeof itemSchema>;

export type WorkListRead = { ok: true; items: WorkItem[] } | { ok: false; errors: string[] };

export function readWorkList(path: string): WorkListRead {
  if (!existsSync(path)) return { ok: true, items: [] };
  const text = parseJsonText(readFileSync(path, 'utf8'));
  const parsed = text.ok ? parseWith(workListSchema, text.value) : text;
  return parsed.ok ? { ok: true, items: parsed.value.items } : parsed;
}

const NOT_BLOCKED: readonly unknown[] = [undefined, null, false, ''];

export function isBlocked(item: WorkItem): boolean {
  return !NOT_BLOCKED.includes(item.blocked);
}

/**
 * A todo item anyone may take, or an item this seat already took, unless it
 * is blocked. A list of only blocked items is no work, so the lead plans.
 */
export function hasWorkFor(items: readonly WorkItem[], seat: string): boolean {
  return items.some((item) => {
    if (isBlocked(item)) return false;
    const isOpen = item.status === 'todo' && item.owner === undefined;
    const isOwnUnfinished = item.owner === seat && (item.status === 'todo' || item.status === 'in-progress');
    return isOpen || isOwnUnfinished;
  });
}

export function readyIds(items: readonly WorkItem[]): string[] {
  return items.filter((item) => item.status === 'ready').map((item) => item.id);
}
