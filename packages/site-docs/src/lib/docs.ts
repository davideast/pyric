import { getCollection, type CollectionEntry } from 'astro:content';

export type DocEntry = CollectionEntry<'docs'>;

/** Route slug for an entry (front-matter override wins). */
export function slugOf(entry: DocEntry): string {
  return entry.data.slug ?? entry.id;
}

/** Path-absolute URL of a doc page, base-aware. `/docs/pyric-tools`. */
export function docPath(entry: DocEntry): string {
  return withBase(`/docs/${slugOf(entry)}`);
}

/** Nav label: the short label if the port set one, else the title. */
export function navLabel(entry: DocEntry): string {
  return entry.data.navLabel ?? entry.data.title;
}

/** Prefix a path-absolute URL with the configured base path. */
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}

/**
 * The Studio shell tab set (packages/studio/src/shell/routes.ts on
 * studio/stack) plus Docs. Docs pages render the same single bar Studio
 * renders; every other tab is a plain link back to Studio's real
 * History-API route, so navigation round-trips: Studio's Docs tab is a
 * full-page link to /docs/, and these tabs are full-page links out.
 * All hrefs are base-aware — the composed static site serves Studio at
 * `${base}/` and the docs at `${base}/docs/`.
 */
export const STUDIO_TABS = [
  { id: 'home', label: 'Home', path: '/' },
  { id: 'firestore', label: 'Firestore', path: '/firestore' },
  { id: 'auth', label: 'Auth', path: '/auth' },
  { id: 'rtdb', label: 'RTDB', path: '/rtdb' },
  { id: 'storage', label: 'Storage', path: '/storage' },
  { id: 'traffic', label: 'Traffic', path: '/traffic' },
  { id: 'prototype', label: 'Prototype', path: '/prototype' },
  { id: 'settings', label: 'Settings', path: '/settings' },
  { id: 'docs', label: 'Docs', path: '/docs' },
] as const;

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

export interface NavGroup {
  group: string;
  sections: NavSection[];
}

/**
 * Public docs as the two-level nav hierarchy: group (source package /
 * subtree, one disclosure each) → section (its existing subdirs:
 * Tutorials / How-to / Reference / …) → pages. Both levels follow
 * `order` order; grouping is by first appearance.
 */
export async function navGroups(): Promise<NavGroup[]> {
  const groups: NavGroup[] = [];
  for (const entry of await publicDocs()) {
    let group = groups[groups.length - 1];
    if (!group || group.group !== entry.data.group) {
      group = { group: entry.data.group, sections: [] };
      groups.push(group);
    }
    const last = group.sections[group.sections.length - 1];
    if (last && last.section === entry.data.section) last.entries.push(entry);
    else group.sections.push({ section: entry.data.section, entries: [entry] });
  }
  return groups;
}

/**
 * First-paragraph excerpt of a markdown body: the first block that is
 * not a heading, code fence, table, list, or HTML comment. Inline
 * markdown syntax is lightly stripped so the excerpt reads as plain
 * text.
 */
export function firstParagraph(body: string): string {
  const structural = /^(#{1,6}\s|```|~~~|\||[-*+]\s|\d+\.\s|>|<!--)/;
  const blocks = body.split(/\n\s*\n/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (structural.test(block)) continue;
    // Some sources pack prose and code/headings without blank lines;
    // keep only the leading prose lines of the block.
    const lines: string[] = [];
    for (const line of block.split('\n')) {
      if (structural.test(line.trim())) break;
      lines.push(line);
    }
    return lines
      .join(' ')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/\*([^*]*)\*/g, '$1')
      .trim();
  }
  return '';
}
