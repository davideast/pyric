/**
 * `work-list.json`: the items the lead plans and the builders take. The
 * sessions write it; the supervisor only reads it, to know whether a builder
 * has work and whether a builder has marked work ready.
 *
 *   { "items": [{ "id": "login-form", "title": "...", "status": "todo" }] }
 *
 * A builder sets `owner` to its seat when it takes an item and `ready` when
 * the item is built. A missing or unreadable list counts as empty, so the
 * lead plans one.
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
}).passthrough();

const workListSchema = z.object({ items: z.array(itemSchema) }).passthrough();

export type WorkItem = z.infer<typeof itemSchema>;

export function readWorkList(path: string): WorkItem[] {
  if (!existsSync(path)) return [];
  const text = parseJsonText(readFileSync(path, 'utf8'));
  const parsed = text.ok ? parseWith(workListSchema, text.value) : text;
  return parsed.ok ? parsed.value.items : [];
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
