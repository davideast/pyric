/**
 * The docs content tree, discovered by `import.meta.glob` — no content
 * collection, no zod. Every `src/content/**\/*.md` file is a page; its route
 * is its path (see routes.ts). Front matter is plain YAML, validated by the
 * build-time assertions below (they throw during `astro build`), not a schema.
 *
 * Authored pages live in the tree as hand-written markdown. Generated pages
 * (conformance matrices, the API reference) are written into
 * `src/content/_generated/` by `scripts/generate-content.ts` right before the
 * build; that directory is gitignored.
 *
 * Front matter:
 *   title       — required. Page title (<title>, llms.txt, index.json).
 *   navLabel    — optional. Shorter sidebar label; defaults to title.
 *   group       — required. Nav top level; must be a known GROUP_ORDER label.
 *   section     — optional. Inner nav heading (Tutorials / How-to / …).
 *   order       — required number. Sort key within the group (spaced by 10s).
 *   description — optional. One-liner for llms.txt / index.json.
 *   internal    — optional bool. Excluded from nav / llms.txt / index.json.
 *   slug        — optional. Route override (used only by the rhythm page).
 *   kind/api*   — generated API pages carry the API-reference template data.
 */
import { readFileSync } from 'node:fs';
import type { MarkdownHeading } from 'astro';
import { canIUse } from '@pyric/cli/conformance';
import { routeForRel } from './routes';
import {
  GROUP_RANK,
  GUIDE_GROUP_LABELS,
} from './nav-groups';

export { GUIDE_GROUP_LABELS };

export interface DocData {
  title: string;
  navLabel?: string;
  group: string;
  section: string;
  order: number;
  description?: string;
  internal: boolean;
  slug?: string;
  kind: 'page' | 'api' | 'api-index';
  apiPackage?: string;
  apiImportPath?: string;
  apiSubpath?: string;
  apiSymbolCount?: number;
  apiEvidenceSlug?: string;
}

interface MarkdownModule {
  frontmatter: Record<string, unknown>;
  file: string;
  Content: unknown;
  getHeadings: () => MarkdownHeading[];
  rawContent: () => string;
}

export interface DocEntry {
  route: string;
  filePath: string;
  data: DocData;
  Content: unknown;
  headings: MarkdownHeading[];
  body: string;
}

const CONTENT_ROOT = '/src/content/';

const modules = import.meta.glob<MarkdownModule>('/src/content/**/*.md', {
  eager: true,
});

function relOf(key: string): string {
  const i = key.indexOf(CONTENT_ROOT);
  return i === -1 ? key : key.slice(i + CONTENT_ROOT.length);
}

function coerce(rel: string, fm: Record<string, unknown>): DocData {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const errors: string[] = [];
  const title = str(fm.title);
  const group = str(fm.group);
  const order = num(fm.order);
  if (!title) errors.push('missing `title`');
  if (!group) errors.push('missing `group`');
  if (order === undefined) errors.push('missing or non-numeric `order`');
  if (errors.length) {
    throw new Error(`content front matter invalid in ${rel}: ${errors.join(', ')}`);
  }
  const kind = str(fm.kind);
  return {
    title: title!,
    navLabel: str(fm.navLabel),
    group: group!,
    section: str(fm.section) ?? '',
    order: order!,
    description: str(fm.description),
    internal: fm.internal === true,
    slug: str(fm.slug),
    kind: kind === 'api' || kind === 'api-index' ? kind : 'page',
    apiPackage: str(fm.apiPackage),
    apiImportPath: str(fm.apiImportPath),
    apiSubpath: str(fm.apiSubpath),
    apiSymbolCount: num(fm.apiSymbolCount),
    apiEvidenceSlug: str(fm.apiEvidenceSlug),
  };
}

const CONFLICT = /^(<{7}|={7}|>{7})( |$)/m;

const entries: DocEntry[] = [];
const byRoute = new Map<string, DocEntry>();

for (const [key, mod] of Object.entries(modules)) {
  const rel = relOf(key);
  const data = coerce(rel, mod.frontmatter);
  const route = routeForRel(rel, data.slug);
  const raw = readFileSync(mod.file, 'utf8');
  if (CONFLICT.test(raw)) {
    throw new Error(`unresolved conflict marker in ${rel}`);
  }
  // Internal pages (the rhythm audit page) never appear in the nav, so their
  // group need not be a public GROUP_ORDER label.
  if (!data.internal && !GROUP_RANK.has(data.group)) {
    throw new Error(
      `unknown group '${data.group}' in ${rel} — add it to GROUP_ORDER (src/lib/nav-groups.ts)`,
    );
  }
  const clash = byRoute.get(route);
  if (clash) {
    throw new Error(
      `route clash '/docs/${route}/': ${relOf(clash.filePath)} vs ${rel}`,
    );
  }
  const entry: DocEntry = {
    route,
    filePath: mod.file,
    data,
    Content: mod.Content,
    headings: mod.getHeadings(),
    body: mod.rawContent(),
  };
  entries.push(entry);
  byRoute.set(route, entry);
}

/** Global order: group rank, then within-group `order`. */
/**
 * Every concrete `pyric can-i-use <query>` example in authored content must
 * resolve to an exact match against the shipped conformance projection. A
 * broken example means the docs promise a capability the CLI can't confirm —
 * this assertion has caught a real drift before. Placeholder forms
 * (`storage/<symbol>`, a bare `foo/`) are illustrative and skipped.
 */
const CAN_I_USE = /\bcan-i-use\s+([A-Za-z0-9][\w./-]*)/g;
for (const entry of entries) {
  if (entry.filePath.replace(/\\/g, '/').includes('/_generated/')) continue;
  for (const m of entry.body.matchAll(CAN_I_USE)) {
    const query = m[1];
    const after = entry.body[m.index! + m[0].length];
    if (after === '<' || query.endsWith('/')) continue; // placeholder
    const result = canIUse(query);
    if (result.match !== 'exact') {
      throw new Error(
        `can-i-use example '${query}' in ${relOf(entry.filePath)} does not resolve to an exact match (got '${result.match}')`,
      );
    }
  }
}

const rankOf = (g: string) => GROUP_RANK.get(g) ?? Number.POSITIVE_INFINITY;
entries.sort((a, b) => {
  const gr = rankOf(a.data.group) - rankOf(b.data.group);
  return gr !== 0 ? gr : a.data.order - b.data.order;
});

/* ── public API (mirrors the old lib/content.ts surface) ─────────────────── */

export function slugOf(entry: DocEntry): string {
  return entry.route;
}

export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, '');
  return `${base}${path}`;
}

export function docPath(entry: DocEntry): string {
  return withBase(`/docs/${entry.route}/`);
}

export function docMdPath(entry: DocEntry): string {
  return withBase(`/docs/${entry.route}.md`);
}

export function navLabel(entry: DocEntry): string {
  return entry.data.navLabel ?? entry.data.title;
}

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

export async function allDocs(): Promise<DocEntry[]> {
  return entries;
}

export async function publicDocs(): Promise<DocEntry[]> {
  return entries.filter((e) => !e.data.internal);
}

export interface NavSection {
  section: string;
  entries: DocEntry[];
}
export interface NavGroup {
  group: string;
  sections: NavSection[];
}

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

export function isGuideGroup(label: string): boolean {
  return GUIDE_GROUP_LABELS.has(label);
}

export function groupLanding(group: NavGroup): DocEntry {
  return (
    group.sections.find((s) => s.section === '')?.entries[0] ??
    group.sections[0].entries[0]
  );
}

function slugifyId(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function groupAnchorId(group: string): string {
  return `nav-group-${slugifyId(group)}`;
}

export function sectionAnchorId(group: string, section: string): string {
  return `nav-section-${slugifyId(group)}-${slugifyId(section)}`;
}

export interface Breadcrumb {
  label: string;
  href: string | null;
  anchorId: string | null;
}

export async function breadcrumbsFor(entry: DocEntry): Promise<Breadcrumb[]> {
  if (entry.data.internal) return [];
  const groups = await navGroups();
  const group = groups.find((g) => g.group === entry.data.group);
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
      anchorId: isGuideGroup(entry.data.group)
        ? sectionAnchorId(entry.data.group, entry.data.section)
        : null,
    });
  }
  crumbs.push({ label: navLabel(entry), href: null, anchorId: null });
  return crumbs;
}

export function firstParagraph(body: string): string {
  const structural = /^(#{1,6}\s|```|~~~|\||[-*+]\s|\d+\.\s|>|<!--)/;
  const blocks = body.split(/\n\s*\n/);
  for (const raw of blocks) {
    const block = raw.trim();
    if (!block) continue;
    if (structural.test(block)) continue;
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
