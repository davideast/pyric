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
import GithubSlugger from 'github-slugger';
import { SUPERSEDED } from './superseded';

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

/**
 * Hand-picked short nav labels (owner review: derived labels were
 * truncating badly in the nav — "How to infer a schema from an exi…").
 * Populated for every page whose auto-shortened label still ran past
 * ~28 chars; keyed by slug so it survives title rewording. Full titles
 * are untouched everywhere else (h1, <title>, llms.txt, index.json,
 * TOC "on this page") — this only swaps the nav item's text.
 */
const NAV_ALIASES: Record<string, string> = {
  'pyric-cli-tutorials-wire-claude-code': 'Wire Claude Code',
  'pyric-rules-how-to-test-rules-against-firebase': 'Test rules against Firebase',
  'pyric-cli-how-to-promote-sandbox-state-to-a-fixture': 'Promote sandbox state',
  'pyric-sandbox-how-to-pick-an-adapter': 'Pick an adapter',
  'pyric-cli-how-to-verify-against-a-captured-session': 'Verify rules',
  'pyric-sandbox-explanation-local-backend-vs-firestore-offline': 'Local backend vs. offline',
  'pyric-sandbox-how-to-multiple-isolated-sandboxes': 'Run isolated sandboxes',
  'pyric-database-explanation-rules-authoring-and-deploy-are-separate': 'Authoring vs. deploy',
  'pyric-firestore-how-to-build-queries': 'Build queries',
  'pyric-rules-how-to-pin-request-time': 'Pin request.time',
  'pyric-storage-how-to-switch-backends': 'Switch backends',
  'ui-traffic-trafficlog': 'TrafficLog components',
  'pyric-admin-firestore-explanation-error-translation': 'Error translation',
  'pyric-admin-firestore-how-to-use-onsnapshot': 'Use onSnapshot',
  'pyric-database-tutorials-01-author-rtdb-rules-with-constraints': 'Author RTDB rules',
  'pyric-sandbox-explanation-why-adapters-are-siblings': 'Why adapters are siblings',
  'pyric-firestore-explanation-rules-tooling-is-separate': 'Rules tooling is separate',
  'pyric-admin-firestore-how-to-translate-denials': 'Translate denials',
  'pyric-storage-explanation-implementation-scope': 'Implementation scope',
  'pyric-storage-how-to-test-rule-expressions': 'Test rule expressions',
  'pyric-admin-firestore-tutorials-01-first-admin-session': 'First admin session',
  'pyric-rules-how-to-compare-rulesets-for-weakening': 'Compare rulesets',
  'pyric-rules-how-to-register-tools-with-an-agent': 'Register rules tools',
  'pyric-sandbox-how-to-use-admin-reads': 'Use admin reads',
  'pyric-cli-how-to-serve-persistence-and-multi-tab': 'Persistence & multi-tab',
  'pyric-firestore-how-to-migrate-from-firebase-firestore': 'Use in existing code',
  'pyric-rules-explanation-agent-failure-modes': 'Agent failure modes',
  'pyric-rules-explanation-sentinel-expression-engine': 'Sentinel expression engine',
  'pyric-cli-how-to-use-the-vite-plugin': 'Use the Vite plugin',
  'ui-auth-authsigninhelper': 'AuthSignInHelper',
  'pyric-sandbox-explanation-listener-re-evaluation': 'Listener re-evaluation',
  'pyric-sandbox-how-to-replay-events': 'Replay events',
  'pyric-storage-tutorials-01-upload-and-download': 'Upload and download',
  'pyric-firestore-compat': 'Conformance matrix',
  'pyric-rules-explanation-lint-vs-validate-vs-simulate-vs-test': 'Lint vs validate vs test',
  'pyric-rules-how-to-inspect-rules-via-the-ast': 'Inspect rules via the AST',
  'pyric-sandbox-explanation-identity-is-a-context': 'Identity is a context',
  'pyric-firestore-explanation-two-backends-one-surface': 'Two backends, one surface',
  'pyric-rules-explanation-runtime-budget-and-shared-gates': 'Runtime budget and gates',
  'pyric-rules-reference-simulator-context': 'Simulator context',
  'pyric-firestore-explanation-target-symbol-opacity': 'TARGET_SYMBOL opacity',
  'pyric-firestore-how-to-pick-a-backend': 'Pick a backend',
  'pyric-firestore-how-to-use-sandbox-ops': 'Use sandbox-only ops',
  'pyric-sandbox-how-to-seed-data-and-rules': 'Seed data and rules',
  'pyric-sandbox-reference-sandbox-and-context': 'Sandbox and context',
  'pyric-storage-compat': 'Conformance matrix',
  'pyric-rules-compat': 'Conformance matrix',
  'pyric-firestore-tutorials-02-swap-to-prod-backend': 'Swap to prod backend',
  'pyric-rules-tutorials-02-write-a-test-suite-for-your-rules': 'Write a rules test suite',
  'pyric-sandbox-how-to-switch-users': 'Switch users',
  'pyric-sandbox-tutorials-02-use-the-sandbox-in-a-test-harness': 'Sandbox in a test harness',
  'pyric-database-compat': 'Conformance matrix',
  'pyric-rules-how-to-resolve-module-imports': 'Resolve 2+modules imports',
  'pyric-auth-compat': 'Conformance matrix',
  'pyric-ai-compat': 'Conformance matrix',
  'pyric-sandbox-reference-snapshot-and-admin': 'Snapshot and admin reads',
  'pyric-cli-how-to-build-a-standalone-binary': 'Build a standalone binary',
  'pyric-admin-firestore-explanation-per-call-delegate': 'Per-call delegate',
  'pyric-admin-firestore-explanation-why-mirror-admin-shape': 'Why mirror the admin SDK',
  'pyric-sandbox-explanation-internal-adapter-protocol': 'The /internal protocol',
  'pyric-sandbox-reference-internal-protocol': 'The /internal protocol',
  'pyric-storage-how-to-list-and-delete': 'List and delete objects',
  'pyric-rules-how-to-simulate-rules-locally': 'Simulate rules locally',
  'pyric-sandbox-how-to-observe-events': 'Observe sandbox events',

};

/** Leading boilerplate the auto-shortening fallback strips before
 *  falling back to the dash/colon-truncated title. Order matters —
 *  first match wins. */
const STRIP_PREFIXES: RegExp[] = [
  /^How to /i,
  /^Use the /i,
  /^Use /i,
  /^Build a /i,
  /^Set up /i,
  /^Write a /i,
];

/**
 * Nav label for a page: the hand-picked alias if the port set one
 * (NAV_ALIASES), else an auto-shortened title — strip a leading
 * boilerplate verb phrase ("How to ", "Use the ", …), then truncate
 * long "Title — subtitle" h1s at the dash/colon. Pages this doesn't
 * get under ~28 chars are exactly the ones NAV_ALIASES should cover;
 * this fallback exists for new pages added between owner passes.
 */
function navLabelFor(slug: string, title: string): string {
  const alias = NAV_ALIASES[slug];
  if (alias) return alias;
  let short = title.split(' — ')[0].split(': ')[0].trim();
  for (const re of STRIP_PREFIXES) {
    if (re.test(short)) {
      short = short.replace(re, '').trim();
      short = short.charAt(0).toUpperCase() + short.slice(1);
      break;
    }
  }
  return short;
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
}

function mdFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    // TypeDoc receipts remain beside the hand-written reference but are not
    // site pages until their cross-links and navigation role are designed.
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
  const title = titleOf(src);
  const clash = bySlug.get(slug);
  if (clash) throw new Error(`slug clash: ${slug} (${clash.src} vs ${src})`);
  const page: Page = {
    src,
    slug,
    group: group.label,
    section,
    order: nextOrder(group.label),
    title: section === '' ? shortTitle(title) : title,
    navLabel: section === '' ? 'Overview' : navLabelFor(slug, title),
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
    title: fm.title ?? titleOf(src),
    navLabel: options.navLabel ?? fm.navLabel,
    description: fm.outcome,
    stripFm: Object.keys(fm).length > 0,
  };
  pages.push(page);
  bySrc.set(src, page);
  bySlug.set(slug, page);
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

// The conformance matrices, right after the guide: the per-service
// conformance tables are the receipt behind the Trust pages and matter
// to agents especially, so they stay itemized in the nav rather than
// folding into the Reference shelf. Slugs are unchanged (slugFor).
const COMPAT_PAGES: { pkg: string; file: string; label: string; slugPrefix?: string }[] = [
  { pkg: 'pyric', file: 'conformance/SCORES.md', label: 'Conformance scores' },
  { pkg: 'pyric', file: 'app/COMPAT.md', label: 'App' },
  { pkg: 'pyric', file: 'firestore/COMPAT.md', label: 'Firestore' },
  { pkg: 'pyric', file: 'auth/COMPAT.md', label: 'Auth' },
  { pkg: 'pyric', file: 'database/COMPAT.md', label: 'Realtime Database' },
  { pkg: 'pyric', file: 'storage/COMPAT.md', label: 'Storage' },
  { pkg: 'pyric', file: 'rules/COMPAT.md', label: 'Rules' },
  { pkg: 'pyric', file: 'messaging/COMPAT.md', label: 'Messaging' },
  { pkg: 'pyric', file: 'ai/COMPAT.md', label: 'AI Logic' },
  {
    pkg: 'cli',
    file: 'functions-rtdb/COMPAT.md',
    label: 'Functions · RTDB',
    slugPrefix: 'pyric-cli',
  },
];
for (const c of COMPAT_PAGES) {
  const src = join(docsRoot(c.pkg), c.file);
  if (!existsSync(src)) throw new Error(`compat matrix missing: ${src}`);
  const slug = slugFor(c.pkg, src, c.slugPrefix);
  const clash = bySlug.get(slug);
  if (clash) throw new Error(`slug clash: ${slug} (${clash.src} vs ${src})`);
  const page: Page = {
    src,
    slug,
    group: 'Conformance',
    section: '',
    order: nextOrder('Conformance'),
    title: titleOf(src),
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
            if (anchorsOf(resolved).has(fragment)) suffix = `#${fragment}`;
            else stats.droppedFragments++;
          }
          stats.rewritten++;
          return `[${label}](../${targetPage.slug}/${suffix})`;
        },
      );
    })
    .join('\n');
}

/* ── Conformance row lists ─────────────────────────────────────────── */
//
// The COMPAT matrices are authored as markdown tables, and a table is
// the wrong display for them: a one-glyph status column between two
// prose columns never aligns, and the probe text fights the behavior
// text for width. On Conformance pages the port rewrites each
// `# | Behavior | Status | Probe [| …]` table into a row list — status
// dot, number, behavior, probe on its own muted line. Tables with any
// other header (the status legend, the target tables) pass through
// untouched. The generator can adopt this shape natively later; until
// then the port owns the transform.

const STATUS_META: Record<string, { key: string; label: string }> = {
  '✓': { key: 'ok', label: 'Conforming' },
  '⚠': { key: 'diverged', label: 'Diverged (documented)' },
  '✗': { key: 'bug', label: 'Bug' },
  '—': { key: 'unsupported', label: 'Unsupported' },
  '?': { key: 'unverified', label: 'Unverified' },
};

/** Inline markdown → HTML for a table cell: code, links, bold, em.
 *  Escapes everything else. Enough for the COMPAT cells, which use
 *  exactly that subset. */
function mdInlineHtml(md: string): string {
  let s = md
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

/** Split a markdown table row into cells (escaped pipes survive). */
function splitRow(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|'));
}

function transformCompatTables(body: string): string {
  return splitFences(body)
    .map((part) => {
      if (part.isFence) return part.text;
      const lines = part.text.split('\n');
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const isHeader =
          /^\s*\|/.test(line) &&
          i + 1 < lines.length &&
          /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1]);
        if (isHeader) {
          const header = splitRow(line).map((h) => h.trim().toLowerCase());
          const col = (name: string) => header.findIndex((h) => h === name || h.startsWith(name));
          const iNum = col('#');
          const iApi = col('api');
          const iCat = col('category');
          const iBeh = col('behavior');
          const iSt = col('status');
          const iPr = col('probe');
          const iMeaning = col('meaning');
          // Consolidated status roundups are two-column API tables. Render
          // them as readable rows under the section that already names the
          // status, without inventing a status dot.
          if (header.length === 2 && header[0] === 'api') {
            let j = i + 2;
            const html: string[] = ['<div class="compat-list compat-list--plain">'];
            while (j < lines.length && /^\s*\|/.test(lines[j])) {
              const cells = splitRow(lines[j]);
              const apiName = (cells[0] ?? '').trim();
              const detail = (cells[1] ?? '').trim();
              const mainInner = apiName
                ? `<code class="compat-api">${mdInlineHtml(apiName)}</code><span class="compat-sub">${mdInlineHtml(detail)}</span>`
                : `<span class="compat-behavior">${mdInlineHtml(detail)}</span>`;
              html.push(
                '<div class="compat-row">',
                `<div class="compat-line"><span class="compat-main">${mainInner}</span></div>`,
                '</div>',
              );
              j++;
            }
            html.push('</div>');
            out.push(html.join('\n'));
            i = j - 1;
            continue;
          }
          // The status legend becomes the key for the dots: one compact
          // line per status, same dot the rows use.
          if (iBeh < 0 && iSt >= 0 && iMeaning >= 0) {
            let j = i + 2;
            const html: string[] = ['<div class="compat-key">'];
            while (j < lines.length && /^\s*\|/.test(lines[j])) {
              const cells = splitRow(lines[j]);
              const glyph = (cells[iSt] ?? '').trim();
              const meta = STATUS_META[glyph];
              if (meta) {
                html.push(
                  `<span class="compat-key-item"><span class="compat-dot" data-status="${meta.key}"></span>${mdInlineHtml(
                    (cells[iMeaning] ?? '').trim(),
                  )}</span>`,
                );
              }
              j++;
            }
            html.push('</div>');
            out.push(html.join('\n'));
            i = j - 1;
            continue;
          }
          if (iBeh >= 0 && iSt >= 0) {
            let j = i + 2;
            const rows: string[][] = [];
            while (j < lines.length && /^\s*\|/.test(lines[j])) {
              rows.push(splitRow(lines[j]));
              j++;
            }
            const html: string[] = ['<div class="compat-list">'];
            for (const cells of rows) {
              const status = (cells[iSt] ?? '').trim();
              // A status may carry a qualifier ("✓ (wrap)"): the glyph
              // drives the dot, the rest joins the evidence.
              const glyph = status.slice(0, 1);
              const meta = STATUS_META[status] ?? STATUS_META[glyph];
              const qualifier = meta && status.length > 1 ? status.slice(1).trim() : '';
              const probe = iPr >= 0 ? (cells[iPr] ?? '').trim() : '';
              const apiName = iApi >= 0 ? (cells[iApi] ?? '').trim() : '';
              const category = iCat >= 0 ? (cells[iCat] ?? '').trim() : '';
              const extras = cells
                .map((c, k) => ({ c, k }))
                .filter(({ k }) => ![iNum, iApi, iCat, iBeh, iSt, iPr].includes(k))
                .map(({ c }) => c.trim())
                .filter(Boolean);
              // The scan line is status plus the API heading and its
              // category/behaviour sub-line. Evidence hides behind a native
              // disclosure; rows without evidence render as plain rows.
              const dot = meta
                ? `<span class="compat-dot" data-status="${meta.key}" role="img" aria-label="${meta.label}" title="${meta.label}"></span>`
                : `<span class="compat-status">${mdInlineHtml(status)}</span>`;
              const behaviorHtml = mdInlineHtml(cells[iBeh] ?? '');
              let mainInner: string;
              if (apiName) {
                const sub = [
                  category ? `<span class="compat-category">${mdInlineHtml(category)}</span>` : '',
                  `<span class="compat-behavior">${behaviorHtml}</span>`,
                ]
                  .filter(Boolean)
                  .join(' · ');
                mainInner = `<code class="compat-api">${mdInlineHtml(apiName)}</code><span class="compat-sub">${sub}</span>`;
              } else {
                mainInner = `<span class="compat-behavior">${behaviorHtml}</span>`;
              }
              const scanLine = [dot, `<span class="compat-main">${mainInner}</span>`].join('');
              const evidence = [
                probe ? `<div class="compat-probe">${mdInlineHtml(probe)}</div>` : '',
                qualifier ? `<div class="compat-note">${mdInlineHtml(qualifier)}</div>` : '',
                ...extras.map((ex) => `<div class="compat-note">${mdInlineHtml(ex)}</div>`),
              ]
                .filter(Boolean)
                .join('\n');
              if (evidence) {
                html.push(
                  `<details class="compat-row" data-status="${meta?.key ?? 'unknown'}">`,
                  `<summary class="compat-line">${scanLine}</summary>`,
                  `<div class="compat-evidence">${evidence}</div>`,
                  '</details>',
                );
              } else {
                html.push(
                  `<div class="compat-row" data-status="${meta?.key ?? 'unknown'}">`,
                  `<div class="compat-line">${scanLine}</div>`,
                  '</div>',
                );
              }
            }
            html.push('</div>');
            out.push(html.join('\n'));
            i = j - 1;
            continue;
          }
        }
        out.push(line);
      }
      return out.join('\n');
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
  const raw = readFileSync(page.src, 'utf8');
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
