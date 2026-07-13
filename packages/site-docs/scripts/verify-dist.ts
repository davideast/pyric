/**
 * Post-build assertions for the docs site. Run after `astro build`:
 *
 *   bun scripts/verify-dist.ts
 *
 * Checks, against dist/ and the content source:
 * 0. Every markdown file under every packages/<pkg>/docs tree (pyric,
 *    pyric-admin, cli, ui) is ported into the collection and
 *    built — the full multi-package port, nothing silently dropped.
 * 1. Every content page has an HTML route (`build.format: 'directory'`
 *    → `/docs/<slug>/index.html`) and a FLAT `.md` twin
 *    (`/docs/<slug>.md`, an API route — not affected by the directory
 *    format), and the twin is byte-identical to the source file minus
 *    its front-matter block.
 * 2. llms.txt lists exactly the public pages (internal pages excluded)
 *    and every linked .md target exists in dist.
 * 3. /docs/index.json has the documented shape, covers exactly the
 *    public pages, and each entry's path + headings resolve.
 * 4. Every internal link (href/src) in the built HTML resolves to a
 *    file in dist, and fragment links point at real element ids.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { SUPERSEDED } from './superseded';
import { join, dirname, resolve, relative, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const contentDir = join(root, 'src', 'content', 'docs');

// Match the build's base path (astro.config.mjs reads the same var).
// Generated URLs are `${base}/docs/...`; dist paths never include it.
const base = (process.env.DOCS_BASE ?? '/').replace(/\/$/, '');
function stripBase(url: string): string {
  return base && url.startsWith(base) ? url.slice(base.length) : url;
}

let failures = 0;
function check(ok: boolean, label: string, detail = '') {
  if (ok) {
    console.log(`  ok  ${label}`);
  } else {
    failures++;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

interface SourcePage {
  file: string;
  slug: string;
  internal: boolean;
  body: string;
}

/** Strip the front-matter block; return { frontmatter, body }. */
function splitFrontmatter(raw: string): { fm: string; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { fm: '', body: raw };
  return { fm: m[1], body: raw.slice(m[0].length) };
}

const sources: SourcePage[] = readdirSync(contentDir)
  .filter((f) => f.endsWith('.md'))
  .map((file) => {
    const raw = readFileSync(join(contentDir, file), 'utf8');
    const { fm, body } = splitFrontmatter(raw);
    const slug = fm.match(/^slug:\s*(\S+)/m)?.[1] ?? file.replace(/\.md$/, '');
    const internal = /^internal:\s*true/m.test(fm);
    return { file, slug, internal, body };
  });

const publicPages = sources.filter((s) => !s.internal);
const internalPages = sources.filter((s) => s.internal);
check(publicPages.length >= 150, `content: ${publicPages.length} public pages`);
check(internalPages.length >= 1, 'content: has an internal rhythm page');

// ── 0. Multi-package coverage: every packages/<pkg>/docs markdown file
//       is ported (same slug mapping as scripts/port-content.ts) and
//       built with its twin. ─────────────────────────────────────────
console.log('\npackage docs coverage');
const repoRoot = resolve(root, '..', '..');
function* walkMd(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMd(full);
    else if (entry.name.endsWith('.md')) yield full;
  }
}
const slugSet = new Set(sources.map((s) => s.slug));
/** Match scripts/port-content.ts slugPrefix overrides (pkg dir ≠ public URL). */
const PKG_SLUG_PREFIX: Record<string, string> = { cli: 'pyric-tools' };
for (const pkg of ['pyric', 'pyric-admin', 'cli', 'ui']) {
  const docsRoot = join(repoRoot, 'packages', pkg, 'docs');
  let count = 0;
  let missing = 0;
  for (const file of walkMd(docsRoot)) {
    // Pages the guide replaced outright are deliberately not built
    // (scripts/superseded.ts) — links to them redirect to the guide.
    if (SUPERSEDED[relative(repoRoot, file).split(sep).join('/')]) continue;
    count++;
    const segs = relative(docsRoot, file)
      .split(sep)
      .join('/')
      .replace(/\.md$/, '')
      .split('/');
    if (segs[segs.length - 1] === 'README') segs.pop();
    const slug = [PKG_SLUG_PREFIX[pkg] ?? pkg, ...segs].join('-').toLowerCase();
    const ok =
      slugSet.has(slug) &&
      existsSync(join(dist, 'docs', slug, 'index.html')) &&
      existsSync(join(dist, 'docs', `${slug}.md`));
    if (!ok) {
      missing++;
      check(false, `ported + built: packages/${pkg}/docs → /docs/${slug}`);
    }
  }
  check(
    count > 0 && missing === 0,
    `packages/${pkg}/docs fully ported (${count} pages)`,
  );
}

// ── 1. Routes + twins ────────────────────────────────────────────────
console.log('\nroutes and .md twins');
for (const page of sources) {
  const html = join(dist, 'docs', page.slug, 'index.html');
  const twin = join(dist, 'docs', `${page.slug}.md`);
  check(existsSync(html), `/docs/${page.slug} built`);
  check(existsSync(twin), `/docs/${page.slug}.md twin exists`);
  if (existsSync(twin)) {
    const twinBytes = readFileSync(twin, 'utf8');
    check(
      twinBytes === page.body,
      `/docs/${page.slug}.md is the exact post-front-matter source`,
      `twin ${twinBytes.length}B vs source body ${page.body.length}B`,
    );
  }
}

// ── 2. llms.txt ──────────────────────────────────────────────────────
console.log('\nllms.txt');
const llmsPath = join(dist, 'llms.txt');
check(existsSync(llmsPath), '/llms.txt exists');
const llms = existsSync(llmsPath) ? readFileSync(llmsPath, 'utf8') : '';
const llmsLinks = [...llms.matchAll(/^- \[([^\]]+)\]\(([^)]+)\)/gm)].map(
  (m) => ({ title: m[1], url: m[2] }),
);
check(
  llmsLinks.length === publicPages.length,
  `llms.txt lists ${publicPages.length} pages`,
  `found ${llmsLinks.length}`,
);
for (const page of internalPages) {
  check(
    !llms.includes(`/${page.slug}`),
    `llms.txt excludes internal /docs/${page.slug}`,
  );
}
for (const link of llmsLinks) {
  const rel = stripBase(link.url).replace(/^\//, '');
  check(
    link.url.endsWith('.md') && existsSync(join(dist, rel)),
    `llms.txt link resolves: ${link.url}`,
  );
}

// ── 3. index.json ────────────────────────────────────────────────────
console.log('\ndocs/index.json');
const indexPath = join(dist, 'docs', 'index.json');
check(existsSync(indexPath), '/docs/index.json exists');
if (existsSync(indexPath)) {
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  check(typeof index.shape === 'string', 'index.json documents its shape');
  check(Array.isArray(index.pages), 'index.json has pages[]');
  check(
    index.pages.length === publicPages.length,
    `index.json covers ${publicPages.length} public pages`,
    `found ${index.pages.length}`,
  );
  for (const p of index.pages) {
    const okShape =
      typeof p.slug === 'string' &&
      typeof p.path === 'string' &&
      typeof p.title === 'string' &&
      typeof p.group === 'string' &&
      typeof p.section === 'string' &&
      typeof p.excerpt === 'string' &&
      Array.isArray(p.headings) &&
      p.headings.every(
        (h: { depth: number; slug: string; text: string }) =>
          typeof h.depth === 'number' &&
          typeof h.slug === 'string' &&
          typeof h.text === 'string',
      );
    check(okShape, `index.json entry shape: ${p.slug}`);
    // `p.path` is `/docs/<slug>/` (trailing slash — directory format);
    // resolve it the same way a static host would: as a directory.
    const htmlPath = join(dist, stripBase(p.path).replace(/^\//, ''), 'index.html');
    check(existsSync(htmlPath), `index.json path resolves: ${p.path}`);
    if (existsSync(htmlPath) && p.headings.length > 0) {
      const html = readFileSync(htmlPath, 'utf8');
      const missing = p.headings.filter(
        (h: { slug: string }) => !html.includes(`id="${h.slug}"`),
      );
      check(
        missing.length === 0,
        `index.json heading anchors exist: ${p.slug}`,
        missing.map((h: { slug: string }) => h.slug).join(', '),
      );
    }
    check(
      !internalPages.some((ip) => ip.slug === p.slug),
      `index.json excludes internal pages (${p.slug})`,
    );
  }
}

// ── 4. Internal links in built HTML resolve ──────────────────────────
console.log('\ninternal links');
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const htmlFiles = [...walk(dist)].filter((f) => f.endsWith('.html'));
check(htmlFiles.length >= sources.length + 2, `${htmlFiles.length} HTML files built`);

for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const pageUrl = '/' + posix.relative(dist, file).replace(/\.html$/, '');
  const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
  // Composition-level links: the Studio shell bar's tabs point at
  // Studio's real routes, which exist once dist/ is merged with the
  // Studio build (the /docs/ seam). They are not in this dist.
  const studioRoutes = new Set([
    '/',
    '/firestore',
    '/auth',
    '/rtdb',
    '/storage',
    '/traffic',
    '/settings',
  ]);
  for (const href of hrefs) {
    if (/^(https?:|mailto:|data:)/.test(href)) continue;
    if (studioRoutes.has(stripBase(href) || '/')) continue;
    const [pathPart, fragment] = href.split('#');
    let target: string;
    if (pathPart === '') {
      target = file; // same-page fragment
    } else {
      const abs = pathPart.startsWith('/')
        ? stripBase(pathPart)
        : posix.resolve(posix.dirname(pageUrl), pathPart);
      const rel = abs.replace(/^\//, '');
      const candidates = [
        join(dist, rel),
        join(dist, `${rel}.html`),
        join(dist, rel, 'index.html'),
      ];
      target = candidates.find((c) => existsSync(c)) ?? '';
      check(target !== '', `link resolves: ${href} (from ${pageUrl})`);
      if (target === '') continue;
    }
    if (fragment && target.endsWith('.html')) {
      const targetHtml = readFileSync(target, 'utf8');
      check(
        targetHtml.includes(`id="${fragment}"`),
        `fragment resolves: ${href} (from ${pageUrl})`,
      );
    }
  }
}

console.log(
  failures === 0
    ? '\nAll dist assertions passed.'
    : `\n${failures} assertion(s) FAILED.`,
);
process.exit(failures === 0 ? 0 : 1);
