import { getCollection, type CollectionEntry } from 'astro:content';

export type DocEntry = CollectionEntry<'docs'>;

/** Route slug for an entry (front-matter override wins). */
export function slugOf(entry: DocEntry): string {
  return entry.data.slug ?? entry.id;
}

/**
 * Path-absolute URL of a doc page, base-aware. `/docs/pyric-cli/`.
 * Trailing slash matters: `build.format: 'directory'` (astro.config.mjs)
 * emits every doc page as `<slug>/index.html`, so the URL must name the
 * directory explicitly — dumb static hosts don't rewrite an
 * extensionless `/docs/pyric-cli` to its `index.html`.
 */
export function docPath(entry: DocEntry): string {
  return withBase(`/docs/${slugOf(entry)}/`);
}

/**
 * Path-absolute URL of a doc page's raw-markdown agent twin — always
 * FLAT (`/docs/pyric-cli.md`), never the directory form `docPath`
 * returns. The twin is an API route ([slug].md.ts), not a content
 * page, so `build.format: 'directory'` doesn't touch it.
 */
export function docMdPath(entry: DocEntry): string {
  return withBase(`/docs/${slugOf(entry)}.md`);
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
 * The guide groups — the outcome-first sections the left nav renders in
 * full. Everything else is reference: the nav collapses each of those
 * groups to a single link (its overview page) under one "Reference"
 * disclosure, so the sidebar reads as a guide, not a manual. The pages
 * themselves are unaffected: still built, still in llms.txt, index.json,
 * and search, still reachable from their overview and in-page links.
 * Must match the porter's GUIDE_GROUPS labels (scripts/port-content.ts).
 */
export const GUIDE_GROUP_LABELS: ReadonlySet<string> = new Set([
  'Overview',
  'Get started',
  'Build',
  'Secure & debug',
  'Observe & shape',
  'Ship & test',
  'Work with an agent',
  'Trust',
  'Conformance',
]);

export function isGuideGroup(label: string): boolean {
  return GUIDE_GROUP_LABELS.has(label);
}

/** A reference group's nav entry point: its overview (section '') page,
 *  else its first page. */
export function groupLanding(group: NavGroup): DocEntry {
  return (
    group.sections.find((s) => s.section === '')?.entries[0] ??
    group.sections[0].entries[0]
  );
}

/** id-safe slug of an arbitrary nav label ("@pyric/cli / verify" -> "pyric-cli-verify"). */
function slugifyId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Anchor id of a group's `<details>` in the left nav (every page renders it). */
export function groupAnchorId(group: string): string {
  return `nav-group-${slugifyId(group)}`;
}

/** Anchor id of a section heading (`<h2>`) inside a group's nav body. */
export function sectionAnchorId(group: string, section: string): string {
  return `nav-section-${slugifyId(group)}-${slugifyId(section)}`;
}

export interface Breadcrumb {
  label: string;
  /** Set when this ancestor has a real landing page. */
  href: string | null;
  /** Set when there's no landing page: a same-page fallback that jumps
   *  to (and, via the browser's native details-fragment behavior,
   *  auto-opens) the matching spot in the left nav. */
  anchorId: string | null;
}

/**
 * Breadcrumb trail for a doc entry: Package / Section / Page.
 *
 * Decision (owner review, item 4): the Package crumb links to its
 * group's overview/README page when the group has one (`section: ''`
 * in the port plan); groups without one (and every Section crumb —
 * there is never a page for a bare reference section) fall back to a
 * same-page anchor into the left nav instead of a dead link. The
 * current page is always plain text (`href: null`, `anchorId: null`).
 */
export async function breadcrumbsFor(entry: DocEntry): Promise<Breadcrumb[]> {
  // Internal pages (the /docs/_rhythm audit page) aren't in navGroups()
  // (publicDocs() filters them out) — no ancestor to point at, and
  // they're already excluded from nav/llms.txt/index.json, so skip the
  // breadcrumb entirely rather than emit a dead nav-anchor fallback.
  if (entry.data.internal) return [];
  const groups = await navGroups();
  const group = groups.find((g) => g.group === entry.data.group);
  // Guide groups may have a dedicated overview (section ''). Reference
  // groups collapse under one "Reference" disclosure with no per-group
  // `<details id>`, so their package crumb must link the overview page
  // (groupLanding) rather than a missing `#nav-group-*` anchor.
  const landing = group
    ? isGuideGroup(entry.data.group)
      ? group.sections.find((s) => s.section === '')?.entries[0]
      : groupLanding(group)
    : undefined;
  const crumbs: Breadcrumb[] = [
    landing
      ? { label: entry.data.group, href: docPath(landing), anchorId: null }
      : {
          label: entry.data.group,
          href: null,
          anchorId: groupAnchorId(entry.data.group),
        },
  ];
  if (entry.data.section) {
    crumbs.push({
      label: entry.data.section,
      href: null,
      // Reference groups collapse to one link in the nav (DocsNav), so
      // their section headings have no anchor to jump to — the crumb
      // renders as plain text there. Guide pages never carry a section.
      anchorId: isGuideGroup(entry.data.group)
        ? sectionAnchorId(entry.data.group, entry.data.section)
        : null,
    });
  }
  crumbs.push({ label: navLabel(entry), href: null, anchorId: null });
  return crumbs;
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
