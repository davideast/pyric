import { getCollection, type CollectionEntry } from 'astro:content';

export type DocEntry = CollectionEntry<'docs'>;

/** Route slug for an entry (front-matter override wins). */
export function slugOf(entry: DocEntry): string {
  return entry.data.slug ?? entry.id;
}

/** Path-absolute URL of a doc page, base-aware. `/docs/get-started`. */
export function docPath(entry: DocEntry): string {
  return withBase(`/docs/${slugOf(entry)}`);
}

/** Prefix a path-absolute URL with the configured base path. */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}

/** Every doc entry, nav order. Includes internal pages. */
export async function allDocs(): Promise<DocEntry[]> {
  const entries = await getCollection('docs');
  return entries.sort((a, b) => a.data.order - b.data.order);
}

/**
 * The public page set — what nav, llms.txt, and index.json all share.
 * Internal pages (the /docs/_rhythm audit page) still build a route
 * and a .md twin but never appear in any generated list.
 */
export async function publicDocs(): Promise<DocEntry[]> {
  return (await allDocs()).filter((e) => !e.data.internal);
}

export interface NavSection {
  section: string;
  entries: DocEntry[];
}

/** Public docs grouped by section, both levels in `order` order. */
export async function navSections(): Promise<NavSection[]> {
  const sections: NavSection[] = [];
  for (const entry of await publicDocs()) {
    const last = sections[sections.length - 1];
    if (last && last.section === entry.data.section) last.entries.push(entry);
    else sections.push({ section: entry.data.section, entries: [entry] });
  }
  return sections;
}

/**
 * First-paragraph excerpt of a markdown body: the first block that is
 * not a heading, code fence, table, or list. Inline markdown syntax is
 * lightly stripped so the excerpt reads as plain text.
 */
export function firstParagraph(body: string): string {
  const blocks = body.split(/\n\s*\n/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (/^(#{1,6}\s|```|~~~|\||[-*+]\s|\d+\.\s|>)/.test(block)) continue;
    return block
      .replace(/\n/g, ' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .trim();
  }
  return '';
}
