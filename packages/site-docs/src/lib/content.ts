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
import { getCollection, render } from 'astro:content';
import { routeForRel } from './routes';
import {
  GROUP_RANK,
  GUIDE_GROUP_LABELS,
} from './nav-groups';
import type { PyricExampleId } from '../examples/registry';

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
  example?: PyricExampleId;
  gallery: boolean;
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
    example: str(fm.example) as PyricExampleId | undefined,
    gallery: fm.gallery === true,
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

/** Generated pages (conformance + API reference) arrive through content-layer
 * loaders; adapt them to the same DocEntry shape the authored glob produces,
 * through the same front-matter validation and route-clash checks. */
async function loadGeneratedEntries(): Promise<DocEntry[]> {
  const collections = [
    ...(await getCollection('conformance')),
    ...(await getCollection('apiReference')),
  ];
  const generated: DocEntry[] = [];
  for (const entry of collections) {
    const rel = `[${entry.collection}] ${entry.id}`;
    const data = coerce(rel, entry.data as Record<string, unknown>);
    const route = entry.id;
    const clash = byRoute.get(route);
    if (clash) {
      throw new Error(`route clash '/docs/${route}/': ${relOf(clash.filePath)} vs ${rel}`);
    }
    const { Content, headings } = await render(entry);
    generated.push({
      route,
      filePath: rel,
      data,
      Content,
      headings,
      body: entry.body ?? '',
    });
  }
  return generated;
}

let merged: Promise<DocEntry[]> | undefined;

function mergedDocs(): Promise<DocEntry[]> {
  merged ??= loadGeneratedEntries().then((generated) => {
    const all = [...entries, ...generated];
    all.sort((a, b) => {
      const gr = rankOf(a.data.group) - rankOf(b.data.group);
      return gr !== 0 ? gr : a.data.order - b.data.order;
    });
    return all;
  });
  return merged;
}

export async function allDocs(): Promise<DocEntry[]> {
  return mergedDocs();
}

export async function publicDocs(): Promise<DocEntry[]> {
  return (await mergedDocs()).filter((e) => !e.data.internal);
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
