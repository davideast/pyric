/**
 * Port every package docs tree into the docs content collection.
 *
 *   bun scripts/port-content.ts
 *
 * Sources — ALL of them, the full port:
 *   packages/pyric/docs         (per-service trees: firestore, rules, …)
 *   packages/pyric-admin/docs
 *   packages/cli/docs   (root tree + bridge)
 *   packages/ui/docs            (per-category component pages)
 *   the in-memory conformance renderer (ten virtual COMPAT/SCORES pages)
 *
 * For each markdown file this writes src/content/docs/<slug>.md:
 * generated front matter (title from the doc's h1, nav group = package /
 * subtree, section = the tree's existing subdir, an order scoped to the
 * doc's nav group — see groupRank below) plus the source body VERBATIM
 * except intra-doc links:
 *
 *   - a relative link that resolves to another ported file is rewritten
 *     to `../<slug>/` — directory-relative to the rendered HTML page,
 *     which `build.format: 'directory'` (astro.config.mjs) emits as
 *     `/docs/<slug>/index.html`. This is relative to the HTML page, NOT
 *     to the flat `.md` agent twin (`/docs/<slug>.md` — see
 *     `[slug].md.ts`); the two are no longer siblings under directory
 *     format. The twin is optimized for LLM/agent reading (plain text,
 *     not click-navigated), so this trade favors the browsing surface;
 *     fragments are kept when the target page really has that heading,
 *     dropped otherwise;
 *   - a relative link that resolves to anything NOT ported (source
 *     files, other packages' internals, stale pre-ADR-001 paths)
 *     becomes plain text — the label stays, the dead link goes;
 *   - absolute (http/mailto) links and same-page `#fragment` links pass
 *     through; code fences are never touched.
 *
 * The script OWNS src/content/docs/ apart from KEEP (hand-written
 * pages): it deletes anything else before writing, so re-running after
 * a source-tree change is the whole sync story. It fails loudly if a
 * source file doesn't fit the declared tree layout (nothing is silently
 * dropped) or if two files map to one slug.
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve, dirname, relative, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPERSEDED } from './superseded';
import { loadConformancePages } from './conformance-pages';
import { transformCompatTables } from './compat-tables';
import { anchorsOf, shortTitle, splitFences, titleOf } from './markdown-structure';
import { navLabelFor } from './nav-label';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const repoRoot = resolve(siteRoot, '..', '..');
const outDir = join(siteRoot, 'src', 'content', 'docs');
const virtualSources = new Map<string, string>();

function readSource(src: string): string {
  return virtualSources.get(src) ?? readFileSync(src, 'utf8');
}

/** Hand-written pages the port never touches. */
const KEEP = new Set(['rhythm.md']);

/* ── The nav plan: group (disclosure) → section (subdir) → files ───── */

interface SectionSpec {
  /** Nav heading; '' renders the pages without a heading (overview). */
  label: string;
  /** Dir relative to the group dir, or a single file name. */
  path: string;
}

interface GroupSpec {
  /** Local workspace directory used to find the docs root. */
  pkg: string;
  /** Stable public slug prefix when it differs from the local directory. */
  slugPrefix?: string;
  /** Nav group label. */
  label: string;
  /** Group dir relative to the package's docs root. */
  dir: string;
  sections: SectionSpec[];
}

const DIATAXIS: SectionSpec[] = [
  { label: '', path: 'README.md' },
  { label: 'Tutorials', path: 'tutorials' },
  { label: 'How-to', path: 'how-to' },
  { label: 'Reference', path: 'reference' },
  { label: 'Explanation', path: 'explanation' },
  // COMPAT.md files are claimed by the Conformance guide group below,
  // not by the per-service reference trees.
];

const GROUPS: GroupSpec[] = [
  {
    pkg: 'cli',
    slugPrefix: 'pyric-cli',
    label: '@pyric/cli',
    dir: '.',
    sections: [
      { label: '', path: 'README.md' },
      { label: 'Tutorials', path: 'tutorials' },
      { label: 'How-to', path: 'how-to' },
      { label: 'Reference', path: 'reference' },
      { label: 'Bridge', path: 'bridge/README.md' },
    ],
  },
  {
    pkg: 'pyric',
    label: 'pyric',
    dir: '.',
    sections: [{ label: 'Explanation', path: 'explanation' }],
  },
  { pkg: 'pyric', label: 'pyric / firestore', dir: 'firestore', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / rules', dir: 'rules', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / sandbox', dir: 'sandbox', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / storage', dir: 'storage', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / auth', dir: 'auth', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / database', dir: 'database', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / ai', dir: 'ai', sections: DIATAXIS },
  { pkg: 'pyric-admin', label: 'pyric-admin / app', dir: 'app', sections: DIATAXIS },
  { pkg: 'pyric-admin', label: 'pyric-admin / firestore', dir: 'firestore', sections: DIATAXIS },
  { pkg: 'pyric-admin', label: 'pyric-admin / auth', dir: 'auth', sections: DIATAXIS },
  { pkg: 'pyric-admin', label: 'pyric-admin / database', dir: 'database', sections: DIATAXIS },
  { pkg: 'pyric-admin', label: 'pyric-admin / storage', dir: 'storage', sections: DIATAXIS },
  {
    pkg: 'ui',
    label: '@pyric/ui',
    dir: '.',
    sections: [
      { label: '', path: 'README.md' },
      { label: 'Primitives', path: 'primitives' },
      { label: 'Firestore', path: 'firestore' },
      { label: 'Storage', path: 'storage' },
      { label: 'Traffic', path: 'traffic' },
      { label: 'Auth', path: 'auth' },
    ],
  },
];

function docsRoot(pkg: string): string {
  return join(repoRoot, 'packages', pkg, 'docs');
}

/* ── The guide: the outcome-first rewrite (docs/site-rewrite/content) ─ */
//
// The guide pages are authored WITH front matter (title, navLabel,
// outcome, status) and link each other relatively (../secure/x.md).
// They port ahead of the package groups so the nav reads guide-first,
// reference below — the HIERARCHY.md plan. Slug = bare file name
// (no package prefix; clash-checked like everything else). `outcome`
// becomes the emitted `description` (llms.txt / index.json).

const guideRoot = join(repoRoot, 'docs', 'site-rewrite', 'content');
const apiReferenceRoot = join(repoRoot, 'docs', 'api-reference');
const API_REFERENCE_GROUP = 'API reference';

/** Superseded package pages (scripts/superseded.ts), by absolute path:
 *  skipped by the port, and links to them rewrite to the guide slug. */
const supersededByAbs = new Map<string, string>(
  Object.entries(SUPERSEDED).map(([rel, slug]) => [join(repoRoot, rel), slug]),
);

interface GuideGroupSpec {
  /** Nav group label (disclosure summary). */
  label: string;
  /** Pages in nav order. Most live in the authored guide tree. A page
   *  may instead name an existing package-doc source so useful depth can
   *  move into the workflow without creating a second copy. */
  pages: Array<{
    dir?: string;
    file?: string;
    source?: string;
    section?: string;
    slug?: string;
    navLabel?: string;
  }>;
}

const GUIDE_GROUPS: GuideGroupSpec[] = [
  { label: 'Overview', pages: [{ file: 'overview.md' }] },
  {
    label: 'Run locally',
    pages: [
      { dir: 'get-started', file: 'start-building.md' },
      { dir: 'get-started', file: 'how-the-swap-works.md' },
      { dir: 'agent', file: 'set-up-your-agent.md' },
      { dir: 'ship', file: 'test-in-node.md' },
    ],
  },
  {
    label: 'Develop with Firebase APIs',
    pages: [
      { dir: 'build', file: 'sign-in-and-manage-users.md' },
      { dir: 'build', file: 'store-and-query-data.md' },
      { dir: 'build', file: 'sync-realtime-data.md' },
      { dir: 'build', file: 'store-files.md' },
      { dir: 'build', file: 'receive-messages.md' },
      { dir: 'build', file: 'run-ai-logic-locally.md' },
      {
        source: 'packages/cli/docs/how-to/run-rtdb-onvaluecreated.md',
        slug: 'pyric-cli-how-to-run-rtdb-onvaluecreated',
        navLabel: 'Run an RTDB function locally',
      },
      { dir: 'build', file: 'which-data-service.md' },
    ],
  },
  {
    label: 'Inspect and correct',
    pages: [
      { dir: 'observe', file: 'see-whats-happening.md', section: 'Inspect the sandbox' },
      { dir: 'secure', file: 'read-a-denial.md', section: 'Inspect the sandbox' },
      { dir: 'observe', file: 'shape-your-data.md', section: 'Inspect the sandbox' },
      { dir: 'agent', file: 'watch-and-review.md', section: 'Inspect the sandbox' },
      { dir: 'secure', file: 'secure-it-with-rules.md', section: 'Correct Security Rules' },
      { dir: 'secure', file: 'simulate-and-lint.md', section: 'Correct Security Rules' },
      { dir: 'secure', file: 'rules-patterns.md', section: 'Correct Security Rules' },
      { dir: 'secure', file: 'rules-standard-library.md', section: 'Correct Security Rules' },
      { dir: 'secure', file: 'rtdb-rules-in-typescript.md', section: 'Correct Security Rules' },
      { dir: 'secure', file: 'firestore-rules-limits.md', section: 'Correct Security Rules' },
      { dir: 'secure', file: 'whats-possible.md', section: 'Correct Security Rules' },
      { dir: 'agent', file: 'what-your-agent-can-do.md', section: 'Work with an agent' },
      { dir: 'agent', file: 'skills.md', section: 'Work with an agent' },
    ],
  },
  {
    label: 'Verify the boundary',
    pages: [
      {
        source: 'packages/cli/docs/how-to/verify-against-a-captured-session.md',
        section: '',
        slug: 'pyric-cli-how-to-verify-against-a-captured-session',
        navLabel: 'Verify a captured session',
      },
      { dir: 'secure', file: 'write-a-rules-test-suite.md' },
      { dir: 'secure', file: 'audit-your-rules.md' },
    ],
  },
  {
    label: 'Ship unchanged',
    pages: [
      { dir: 'ship', file: 'ship-to-production.md' },
      { dir: 'ship', file: 'set-up-the-project.md' },
    ],
  },
  {
    label: 'Conformance',
    pages: [
      { dir: 'trust', file: 'how-we-know-it-matches-firebase.md' },
      { dir: 'trust', file: 'whats-experimental.md' },
    ],
  },
];

/** Guide files the port ignores (review scaffolding, not pages). */
const GUIDE_IGNORE = new Set(['README.md']);

/** Parse a leading YAML front-matter block (string values only — the
 *  guide's authoring schema). Returns {} and the untouched body when
 *  there is none. */
function parseFrontmatter(raw: string): {
  fm: Record<string, string>;
  body: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { fm: {}, body: raw };
  const fm: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].replace(/^"(.*)"$/, '$1').trim();
  }
  return { fm, body: raw.slice(m[0].length) };
}

/** Slug for a source file: pkg id + docs-root-relative path, lowercased,
 *  separators → '-', README segment dropped. Unique by assertion. */
function slugFor(pkg: string, absFile: string, slugPrefix = pkg): string {
  const rel = relative(docsRoot(pkg), absFile).split(sep).join('/');
  const segs = rel.replace(/\.md$/, '').split('/');
  if (segs[segs.length - 1] === 'README') segs.pop();
  return [slugPrefix, ...segs].join('-').toLowerCase();
}

/* ── Collect pages ─────────────────────────────────────────────────── */

interface Page {
  src: string; // absolute source path
  slug: string;
  group: string;
  section: string;
  order: number;
  title: string;
  navLabel?: string;
  /** llms.txt / index.json one-liner (guide pages: the `outcome`). */
  description?: string;
  /** Guide pages author their own front matter; strip it at emit. */
  stripFm?: boolean;
  api?: {
    kind: 'api' | 'api-index';
    packageName?: string;
    importPath?: string;
    subpath?: string;
    symbolCount?: number;
    evidenceSlug?: string;
  };
}

function mdFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    // Ignore any stale declaration receipts. The generated API reference has
    // one authoritative source tree under docs/api-reference.
    .filter((f) => !f.endsWith('.generated.md'))
    .sort()
    .map((f) => join(dir, f));
}

const pages: Page[] = [];
const bySrc = new Map<string, Page>();
const bySlug = new Map<string, Page>();

/**
 * Order is scoped per nav group instead of one counter across the whole
 * tree: each group gets a rank spaced by 1000, comfortably above the
 * largest group's page count, and each page an offset from 1 within its
 * group. `order = groupRank + offset`. Adding a doc then renumbers at
 * most the trailing pages of its own group. Workflow groups follow
 * GUIDE_GROUPS order. Reference group ranks stay fixed below them.
 */
const GROUP_RANK_SPACING = 1000;
// Reference groups began at rank 9 in the previous hierarchy. Keep that
// stable so changing the primary workflow does not rewrite front matter for
// every generated reference page. Guide ranks may change with the workflow;
// reference ranks are a durable shelf below it.
const REFERENCE_GROUP_START_RANK = 9;
const groupRank = new Map([
  ...GUIDE_GROUPS.map((group, i) => [group.label, i * GROUP_RANK_SPACING] as const),
  ...GROUPS.map((group, i) => [
    group.label,
    (REFERENCE_GROUP_START_RANK + i) * GROUP_RANK_SPACING,
  ] as const),
  [
    API_REFERENCE_GROUP,
    (REFERENCE_GROUP_START_RANK + GROUPS.length) * GROUP_RANK_SPACING,
  ] as const,
]);
const groupPosition = new Map<string, number>();
function nextOrder(group: string): number {
  const rank = groupRank.get(group);
  if (rank === undefined) throw new Error(`group has no rank: ${group}`);
  const position = (groupPosition.get(group) ?? 0) + 1;
  groupPosition.set(group, position);
  if (position >= GROUP_RANK_SPACING) {
    throw new Error(`group exceeds GROUP_RANK_SPACING (${GROUP_RANK_SPACING}): ${group}`);
  }
  return rank + position;
}

function addPage(src: string, group: GroupSpec, section: string) {
  if (supersededByAbs.has(src) || bySrc.has(src)) return; // replaced or promoted into the guide
  const slug = slugFor(group.pkg, src, group.slugPrefix);
  const title = titleOf(src, readSource);
  const { fm } = parseFrontmatter(readSource(src));
  const clash = bySlug.get(slug);
  if (clash) throw new Error(`slug clash: ${slug} (${clash.src} vs ${src})`);
  const page: Page = {
    src,
    slug,
    group: group.label,
    section,
    order: nextOrder(group.label),
    title: section === '' ? shortTitle(title) : title,
    navLabel: section === '' ? 'Overview' : fm.navLabel ?? navLabelFor(title),
    stripFm: true,
  };
  pages.push(page);
  bySrc.set(src, page);
  bySlug.set(slug, page);
}

/** Add one guide page: slug from the bare file name, title/navLabel/
 *  description from its own front matter (title falls back to the h1). */
function addGuidePage(
  src: string,
  groupLabel: string,
  section = '',
  options: { slug?: string; navLabel?: string } = {},
) {
  const { fm } = parseFrontmatter(readFileSync(src, 'utf8'));
  const slug = options.slug ?? posix.basename(src, '.md').toLowerCase();
  const clash = bySlug.get(slug);
  if (clash) throw new Error(`slug clash: ${slug} (${clash.src} vs ${src})`);
  const page: Page = {
    src,
    slug,
    group: groupLabel,
    section,
    order: nextOrder(groupLabel),
    title: fm.title ?? titleOf(src, readSource),
    navLabel: options.navLabel ?? fm.navLabel,
    description: fm.outcome,
    stripFm: Object.keys(fm).length > 0,
  };
  pages.push(page);
  bySrc.set(src, page);
  bySlug.set(slug, page);
}

/** Add a generated API page while preserving the metadata consumed by the
 * dedicated API-reference layout. */
function addApiPage(src: string) {
  const { fm } = parseFrontmatter(readFileSync(src, 'utf8'));
  const kind = fm.kind;
  if (kind !== 'api' && kind !== 'api-index') {
    throw new Error(`generated API page has invalid kind: ${src}`);
  }
  if (!fm.slug) throw new Error(`generated API page has no slug: ${src}`);
  if (kind === 'api' && (!fm.apiPackage || !fm.apiImportPath || !fm.apiSymbolCount)) {
    throw new Error(`generated API page is missing template metadata: ${src}`);
  }
  const clash = bySlug.get(fm.slug);
  if (clash) throw new Error(`slug clash: ${fm.slug} (${clash.src} vs ${src})`);
  const page: Page = {
    src,
    slug: fm.slug,
    group: API_REFERENCE_GROUP,
    section: kind === 'api' ? fm.apiPackage : '',
    order: nextOrder(API_REFERENCE_GROUP),
    title: fm.title ?? titleOf(src, readSource),
    navLabel: fm.navLabel,
    description: fm.outcome,
    stripFm: true,
    api: {
      kind,
      packageName: fm.apiPackage,
      importPath: fm.apiImportPath,
      subpath: fm.apiSubpath,
      symbolCount: fm.apiSymbolCount ? Number(fm.apiSymbolCount) : undefined,
      evidenceSlug: fm.apiEvidenceSlug,
    },
  };
  pages.push(page);
  bySrc.set(src, page);
  bySlug.set(page.slug, page);
}

// Guide first: the nav renders groups in `order` order, so the
// outcome-first sections sit above the package reference groups.
for (const group of GUIDE_GROUPS) {
  for (const page of group.pages) {
    const p = page.source
      ? resolve(repoRoot, page.source)
      : resolve(guideRoot, page.dir ?? '', page.file ?? '');
    if (!existsSync(p)) throw new Error(`guide page missing: ${p}`);
    addGuidePage(p, group.label, page.section ?? '', {
      slug: page.slug,
      navLabel: page.navLabel,
    });
  }
}

// One generated API shelf after the workflow and package reference groups.
// The shelf collapses to its index in the sidebar; every subpath route remains
// searchable, linkable, and available through the index and package docs.
const apiIndex = join(apiReferenceRoot, 'index.md');
if (!existsSync(apiIndex)) throw new Error(`API reference index missing: ${apiIndex}`);
addApiPage(apiIndex);
const apiGeneratedRoot = join(apiReferenceRoot, 'generated');
for (const file of mdFilesIn(apiGeneratedRoot)) addApiPage(file);

// The conformance matrices, right after the guide: the per-service
// conformance tables are the receipt behind the Trust pages and matter
// to agents especially, so they stay itemized in the nav rather than
// folding into the Reference shelf. Slugs are unchanged (slugFor).
for (const c of await loadConformancePages(repoRoot)) {
  const src = c.src;
  virtualSources.set(src, c.rendered);
  const slug = slugFor(c.pkg, src, c.slugPrefix);
  const clash = bySlug.get(slug);
  if (clash) throw new Error(`slug clash: ${slug} (${clash.src} vs ${src})`);
  const page: Page = {
    src,
    slug,
    group: 'Conformance',
    section: '',
    order: nextOrder('Conformance'),
    title: titleOf(src, readSource),
    navLabel: c.label,
  };
  pages.push(page);
  bySrc.set(src, page);
  bySlug.set(slug, page);
}

for (const group of GROUPS) {
  const groupDir = resolve(docsRoot(group.pkg), group.dir);
  for (const spec of group.sections) {
    const p = resolve(groupDir, spec.path);
    if (!existsSync(p)) continue; // not every tree has every quadrant
    if (statSync(p).isDirectory()) {
      for (const f of mdFilesIn(p)) addPage(f, group, spec.label);
    } else {
      addPage(p, group, spec.label);
    }
  }
}

// Nothing silently dropped: every .md under every docs root must have
// been claimed by exactly one group section.
function* walkMd(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMd(full);
    else if (entry.name.endsWith('.md') && !entry.name.endsWith('.generated.md')) yield full;
  }
}
for (const pkg of ['pyric', 'pyric-admin', 'cli', 'ui']) {
  for (const f of walkMd(docsRoot(pkg))) {
    if (!bySrc.has(f) && !supersededByAbs.has(f)) {
      throw new Error(`unclaimed source doc: ${f}`);
    }
  }
}
// Same strictness for the guide tree (README.md is review scaffolding).
for (const f of walkMd(guideRoot)) {
  if (GUIDE_IGNORE.has(posix.basename(f))) continue;
  if (!bySrc.has(f)) throw new Error(`unclaimed guide page: ${f}`);
}
for (const f of walkMd(apiReferenceRoot)) {
  if (!bySrc.has(f)) throw new Error(`unclaimed API reference page: ${f}`);
}

/* ── Link rewriting ────────────────────────────────────────────────── */

const stats = { rewritten: 0, unlinked: 0, droppedFragments: 0 };
const unlinkedLog: string[] = [];

/**
 * Resolve a relative link target from `srcDir` to a ported page. Two
 * historical spellings are healed rather than unlinked:
 *   - `docs/…` self-prefix: service READMEs written as if they lived at
 *     the package root (`./docs/tutorials/x.md`) while sitting IN docs/;
 *   - stale pre-ADR-001 sibling-package paths (`../../../sandbox/docs/…`)
 *     whose trees now live under `packages/pyric/docs/<service>/…`.
 */
function resolveTarget(srcDir: string, target: string): string | null {
  const tryAbs = (abs: string): string | null => {
    const candidates = abs.endsWith('/')
      ? [join(abs, 'README.md')]
      : [abs, `${abs}.md`, join(abs, 'README.md')];
    for (const c of candidates) if (bySrc.has(c)) return c;
    return null;
  };
  const clean = decodeURI(target);
  const direct = tryAbs(resolve(srcDir, clean) + (clean.endsWith('/') ? '/' : ''));
  if (direct) return direct;
  // `docs/` self-prefix.
  const selfPrefixed = clean.replace(/^(\.\/)?docs\//, '');
  if (selfPrefixed !== clean) {
    const healed = tryAbs(
      resolve(srcDir, selfPrefixed) + (clean.endsWith('/') ? '/' : ''),
    );
    if (healed) return healed;
  }
  // Stale sibling-package path → the pyric umbrella's per-service tree.
  const abs = resolve(srcDir, clean).split(sep).join('/');
  const stale = abs.match(
    /\/(sandbox|firestore|rules|storage|auth|database)\/docs\/(.+)$/,
  );
  if (stale) {
    const healed = tryAbs(
      join(repoRoot, 'packages', 'pyric', 'docs', stale[1], stale[2]) +
        (clean.endsWith('/') ? '/' : ''),
    );
    if (healed) return healed;
  }
  return null;
}

function rewriteLinks(page: Page, body: string): string {
  const srcDir = dirname(page.src);
  return splitFences(body)
    .map((part) => {
      if (part.isFence) return part.text;
      return part.text.replace(
        /\[([^\]]*)\]\(([^)\s]+)\)/g,
        (whole, label: string, target: string) => {
          if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return whole; // absolute
          if (target.startsWith('#')) {
            // Same-page anchor: keep if the heading exists (healing
            // GitHub's `user-content-` prefix), else unlink.
            const id = target.slice(1).replace(/^user-content-/, '');
            // TypeDoc owns its repeated-member anchor model. Preserve those
            // generated links verbatim and let the built-site fragment gate
            // validate the rendered target.
            if (page.api?.kind === 'api') return `[${label}](#${id})`;
            if (anchorsOf(page.src, readSource).has(id)) return `[${label}](#${id})`;
            stats.unlinked++;
            unlinkedLog.push(`${page.slug}: ${target}`);
            return label;
          }
          const [path, rawFragment] = target.split('#');
          const fragment = rawFragment?.replace(/^user-content-/, '');
          const resolved = resolveTarget(srcDir, path);
          if (!resolved) {
            // A link to a superseded page follows the replacement.
            const clean = decodeURI(path);
            for (const cand of [resolve(srcDir, clean), resolve(srcDir, clean.replace(/^(\.\/)?docs\//, ''))]) {
              const slug = supersededByAbs.get(cand) ?? supersededByAbs.get(`${cand}.md`);
              if (slug) {
                stats.rewritten++;
                return `[${label}](../${slug}/)`;
              }
            }
            stats.unlinked++;
            unlinkedLog.push(`${page.slug}: ${target}`);
            return label;
          }
          const targetPage = bySrc.get(resolved)!;
          let suffix = '';
          if (fragment) {
            if (anchorsOf(resolved, readSource).has(fragment)) suffix = `#${fragment}`;
            else stats.droppedFragments++;
          }
          stats.rewritten++;
          return `[${label}](../${targetPage.slug}/${suffix})`;
        },
      );
    })
    .join('\n');
}

/* ── Emit ──────────────────────────────────────────────────────────── */

function yamlQuote(s: string): string {
  return JSON.stringify(s);
}

for (const stale of readdirSync(outDir)) {
  if (!KEEP.has(stale)) unlinkSync(join(outDir, stale));
}

for (const page of pages) {
  const raw = readSource(page.src);
  const source = page.stripFm ? parseFrontmatter(raw).body : raw;
  let body = rewriteLinks(page, source);
  if (page.group === 'Conformance') body = transformCompatTables(body);
  const fm = [
    '---',
    `title: ${yamlQuote(page.title)}`,
    ...(page.navLabel && page.navLabel !== page.title
      ? [`navLabel: ${yamlQuote(page.navLabel)}`]
      : []),
    `group: ${yamlQuote(page.group)}`,
    `section: ${yamlQuote(page.section)}`,
    `order: ${page.order}`,
    ...(page.description ? [`description: ${yamlQuote(page.description)}`] : []),
    ...(page.api
      ? [
          `kind: ${yamlQuote(page.api.kind)}`,
          ...(page.api.packageName
            ? [`apiPackage: ${yamlQuote(page.api.packageName)}`]
            : []),
          ...(page.api.importPath
            ? [`apiImportPath: ${yamlQuote(page.api.importPath)}`]
            : []),
          ...(page.api.subpath !== undefined
            ? [`apiSubpath: ${yamlQuote(page.api.subpath)}`]
            : []),
          ...(page.api.symbolCount !== undefined
            ? [`apiSymbolCount: ${page.api.symbolCount}`]
            : []),
          ...(page.api.evidenceSlug
            ? [`apiEvidenceSlug: ${yamlQuote(page.api.evidenceSlug)}`]
            : []),
        ]
      : []),
    '---',
    '',
  ].join('\n');
  writeFileSync(join(outDir, `${page.slug}.md`), fm + body);
}

const perGroup = new Map<string, number>();
for (const p of pages) perGroup.set(p.group, (perGroup.get(p.group) ?? 0) + 1);
console.log(`ported ${pages.length} pages:`);
for (const [g, n] of perGroup) console.log(`  ${String(n).padStart(3)}  ${g}`);
console.log(
  `links: ${stats.rewritten} rewritten, ${stats.unlinked} unlinked (plain text), ` +
    `${stats.droppedFragments} fragments dropped`,
);
if (process.env.PORT_VERBOSE && unlinkedLog.length) {
  console.log('\nunlinked targets:');
  for (const l of unlinkedLog) console.log(`  ${l}`);
}
