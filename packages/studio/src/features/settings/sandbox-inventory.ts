/**
 * The Sandbox card's live-inventory line (PURE).
 *
 * The card teaches by showing what the sandbox IS right now — this module
 * turns the resource index the Home typeahead already builds (no new
 * counting ops) into that one line. Documents are deliberately excluded:
 * the index fetches them under per-collection caps, so a document count
 * would under-report; collections, users, objects, and RTDB keys are
 * effectively exact at sandbox scale.
 */

import type { ResourceEntry } from '../home/typeahead.js';

export interface InventoryCounts {
  collections: number;
  users: number;
  objects: number;
  rtdbKeys: number;
}

/** Count the index by kind. Null in → null out (index not built yet). */
export function countInventory(
  entries: readonly ResourceEntry[] | null,
): InventoryCounts | null {
  if (entries === null) return null;
  const counts: InventoryCounts = { collections: 0, users: 0, objects: 0, rtdbKeys: 0 };
  for (const e of entries) {
    if (e.kind === 'collection') counts.collections++;
    else if (e.kind === 'user') counts.users++;
    else if (e.kind === 'object') counts.objects++;
    else if (e.kind === 'rtdb-key') counts.rtdbKeys++;
  }
  return counts;
}

function part(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * One human line for the card's first row: `"3 collections · 4 users ·
 * 2 files"`. Zero-count kinds are omitted; an empty sandbox says so;
 * a not-yet-measured one reads as a quiet placeholder.
 */
export function inventoryLine(counts: InventoryCounts | null): string {
  if (counts === null) return 'measuring…';
  const parts: string[] = [];
  if (counts.collections) parts.push(part(counts.collections, 'collection'));
  if (counts.users) parts.push(part(counts.users, 'user'));
  if (counts.objects) parts.push(part(counts.objects, 'file'));
  if (counts.rtdbKeys) parts.push(part(counts.rtdbKeys, 'RTDB key'));
  return parts.length ? parts.join(' · ') : 'empty — no data yet';
}
