/**
 * Port every package docs tree into the docs content collection.
 *
 *   bun scripts/port-content.ts
 *
 * Sources — ALL of them, the full port:
 *   packages/pyric/docs         (per-service trees: firestore, rules, …)
 *   packages/pyric-admin/docs
 *   packages/pyric-tools/docs   (root tree + deploy + bridge)
 *   packages/ui/docs            (per-category component pages)
 *
 * For each markdown file this writes src/content/docs/<slug>.md:
 * generated front matter (title from the doc's h1, nav group = package /
 * subtree, section = the tree's existing subdir, global order) plus the
 * source body VERBATIM except intra-doc links:
 *
 *   - a relative link that resolves to another ported file is rewritten
 *     to that page's slug (sibling-relative; `build.format: 'file'`
 *     keeps /docs/a and /docs/a.md siblings so it works from both);
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
import GithubSlugger from 'github-slugger';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const repoRoot = resolve(siteRoot, '..', '..');
const outDir = join(siteRoot, 'src', 'content', 'docs');

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
  /** Package id — the slug prefix comes from the docs-root-relative
   *  path, so this is only used to find the docs root. */
  pkg: string;
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
  { label: 'Compat', path: 'COMPAT.md' },
];

const GROUPS: GroupSpec[] = [
  {
    pkg: 'pyric-tools',
    label: 'pyric-tools',
    dir: '.',
    sections: [
      { label: '', path: 'README.md' },
      { label: 'Tutorials', path: 'tutorials' },
      { label: 'How-to', path: 'how-to' },
      { label: 'Reference', path: 'reference' },
      { label: 'Bridge', path: 'bridge/README.md' },
    ],
  },
  { pkg: 'pyric-tools', label: 'pyric-tools / deploy', dir: 'deploy', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / firestore', dir: 'firestore', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / rules', dir: 'rules', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / sandbox', dir: 'sandbox', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / storage', dir: 'storage', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / auth', dir: 'auth', sections: DIATAXIS },
  { pkg: 'pyric', label: 'pyric / database', dir: 'database', sections: DIATAXIS },
  { pkg: 'pyric-admin', label: 'pyric-admin / firestore', dir: 'firestore', sections: DIATAXIS },
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

/** Slug for a source file: pkg id + docs-root-relative path, lowercased,
 *  separators → '-', README segment dropped. Unique by assertion. */
function slugFor(pkg: string, absFile: string): string {
  const rel = relative(docsRoot(pkg), absFile).split(sep).join('/');
  const segs = rel.replace(/\.md$/, '').split('/');
  if (segs[segs.length - 1] === 'README') segs.pop();
  return [pkg, ...segs].join('-').toLowerCase();
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
}

function mdFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => join(dir, f));
}

const pages: Page[] = [];
const bySrc = new Map<string, Page>();
const bySlug = new Map<string, Page>();
let order = 1;

function addPage(src: string, group: GroupSpec, section: string) {
  const slug = slugFor(group.pkg, src);
  const title = titleOf(src);
  const clash = bySlug.get(slug);
  if (clash) throw new Error(`slug clash: ${slug} (${clash.src} vs ${src})`);
  const page: Page = {
    src,
    slug,
    group: group.label,
    section,
    order: order++,
    title: section === '' ? shortTitle(title) : title,
    navLabel: section === '' ? 'Overview' : shortNavLabel(title),
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
    else if (entry.name.endsWith('.md')) yield full;
  }
}
for (const pkg of ['pyric', 'pyric-admin', 'pyric-tools', 'ui']) {
  for (const f of walkMd(docsRoot(pkg))) {
    if (!bySrc.has(f)) throw new Error(`unclaimed source doc: ${f}`);
  }
}

/* ── Markdown helpers (fence-aware) ────────────────────────────────── */

/** Split a body into alternating [text, fence, text, fence, …] parts. */
function splitFences(body: string): { text: string; isFence: boolean }[] {
  const parts: { text: string; isFence: boolean }[] = [];
  const lines = body.split('\n');
  let buf: string[] = [];
  let fence: string | null = null;
  let fenceBuf: string[] = [];
  for (const line of lines) {
    const open = line.match(/^\s*(```+|~~~+)/);
    if (fence === null && open) {
      parts.push({ text: buf.join('\n'), isFence: false });
      buf = [];
      fence = open[1][0].repeat(3);
      fenceBuf = [line];
    } else if (fence !== null) {
      fenceBuf.push(line);
      if (line.trim().startsWith(fence)) {
        parts.push({ text: fenceBuf.join('\n'), isFence: true });
        fenceBuf = [];
        fence = null;
      }
    } else {
      buf.push(line);
    }
  }
  if (fence !== null) parts.push({ text: fenceBuf.join('\n'), isFence: true });
  else parts.push({ text: buf.join('\n'), isFence: false });
  return parts;
}

/** Markdown inline syntax → plain text (what the rendered heading says). */
function inlineText(md: string): string {
  return md
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .trim();
}

/** ATX headings of a file, outside code fences. */
function headingsOf(src: string): string[] {
  const out: string[] = [];
  for (const part of splitFences(readFileSync(src, 'utf8'))) {
    if (part.isFence) continue;
    for (const line of part.text.split('\n')) {
      const m = line.match(/^#{1,6}\s+(.*)$/);
      if (m) out.push(inlineText(m[1]));
    }
  }
  return out;
}

/** The doc's title: its first h1 (rendered text), else the file name. */
function titleOf(src: string): string {
  for (const part of splitFences(readFileSync(src, 'utf8'))) {
    if (part.isFence) continue;
    for (const line of part.text.split('\n')) {
      const m = line.match(/^#\s+(.*)$/);
      if (m) return inlineText(m[1]);
    }
  }
  return posix.basename(src, '.md');
}

/** Nav items truncate long "Title — subtitle" h1s at the dash/colon. */
function shortNavLabel(title: string): string {
  return title.split(' — ')[0].split(': ')[0].trim();
}

/** Overview titles keep the doc identity but drop trailing " docs" etc. */
function shortTitle(title: string): string {
  return title.replace(/\s+(documentation|docs)$/i, '');
}

/** github-slugger ids of a target file's headings — what Astro emits. */
const anchorCache = new Map<string, Set<string>>();
function anchorsOf(src: string): Set<string> {
  let set = anchorCache.get(src);
  if (!set) {
    const slugger = new GithubSlugger();
    set = new Set(headingsOf(src).map((h) => slugger.slug(h)));
    anchorCache.set(src, set);
  }
  return set;
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
            if (anchorsOf(page.src).has(id)) return `[${label}](#${id})`;
            stats.unlinked++;
            unlinkedLog.push(`${page.slug}: ${target}`);
            return label;
          }
          const [path, rawFragment] = target.split('#');
          const fragment = rawFragment?.replace(/^user-content-/, '');
          const resolved = resolveTarget(srcDir, path);
          if (!resolved) {
            stats.unlinked++;
            unlinkedLog.push(`${page.slug}: ${target}`);
            return label;
          }
          const targetPage = bySrc.get(resolved)!;
          let suffix = '';
          if (fragment) {
            if (anchorsOf(resolved).has(fragment)) suffix = `#${fragment}`;
            else stats.droppedFragments++;
          }
          stats.rewritten++;
          return `[${label}](${targetPage.slug}${suffix})`;
        },
      );
    })
    .join('');
}

/* ── Emit ──────────────────────────────────────────────────────────── */

function yamlQuote(s: string): string {
  return JSON.stringify(s);
}

for (const stale of readdirSync(outDir)) {
  if (!KEEP.has(stale)) unlinkSync(join(outDir, stale));
}

for (const page of pages) {
  const body = rewriteLinks(page, readFileSync(page.src, 'utf8'));
  const fm = [
    '---',
    `title: ${yamlQuote(page.title)}`,
    ...(page.navLabel && page.navLabel !== page.title
      ? [`navLabel: ${yamlQuote(page.navLabel)}`]
      : []),
    `group: ${yamlQuote(page.group)}`,
    `section: ${yamlQuote(page.section)}`,
    `order: ${page.order}`,
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
