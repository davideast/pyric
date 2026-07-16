/**
 * Mechanical rhythm audit — run after `astro build`:
 *
 *   bun scripts/audit-rhythm.ts
 *
 * The owner flagged inconsistent vertical spacing (a large gap before
 * an h2 that looked like it might be compounding margins from more
 * than one source). rhythm.css documents a single-source cascade
 * where every rule is `.prose > X [+ Y]` (equal specificity, source
 * order decides), so nothing SHOULD be able to compound. This script
 * makes that a build-checked fact instead of a code-review claim:
 *
 * For every sample page, it renders the built HTML in a real browser
 * (Playwright/Chromium, `file://` — no server needed), walks the
 * `.prose` article's direct children, measures the actual pixel gap
 * between each consecutive pair (bottom of A to top of B — the
 * rendered gap, margin-collapse included), classifies the pair by the
 * SAME rule-precedence rhythm.css uses (see the mapping below, which
 * mirrors the cascade order documented in rhythm.css's header), and
 * fails if the measured gap is off by more than 1px from the token
 * it should be.
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('dist/ not found — run `astro build` first.');
  process.exit(1);
}

// Serve dist/ over real HTTP: the built pages reference stylesheets by
// root-absolute URL (`/_astro/….css`), which only resolves under an
// http(s) origin — loading the HTML via `file://` silently drops every
// stylesheet and measures the browser's UA-default margins instead of
// rhythm.css, which looks exactly like "spacing is inconsistent" but
// isn't the bug it appears to be.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = Bun.file(join(dist, path));
    if (await file.exists()) return new Response(file);
    return new Response('Not found', { status: 404 });
  },
});
const base = `http://localhost:${server.port}`;

// Token values in px, at the root 16px font-size rhythm.css's rem
// tokens resolve against (site.css never overrides html font-size).
const TOKENS = {
  para: 14, // 0.875rem
  group: 24, // 1.5rem
  subsection: 36, // 2.25rem
  section: 52, // 3.25rem
  list: 10.5, // calc(0.875rem * 0.75) — the li + li beat
} as const;
type Adjacency = keyof typeof TOKENS;

// Non-adjacency rhythm facts, asserted as computed styles: blockquote
// internal breathing room is a full para beat (site.css derives its
// padding-block from --rhythm-para).
const BLOCKQUOTE_PADDING_BLOCK = 14;

const HEADINGS = new Set(['H1', 'H2', 'H3', 'H4']);

/**
 * Classify a sibling pair the way rhythm.css's cascade actually
 * resolves it (source order, not selector "meaning"): tight bindings
 * (rule 4 in the header) are declared LAST, so a heading always wins
 * as the PARA beat for whatever follows it — even if that's another
 * heading a section/subsection rule would otherwise claim.
 */
function classify(prevTag: string, curTag: string): Adjacency {
  if (HEADINGS.has(prevTag)) return 'para'; // h* + anything
  if (curTag === 'H2') return 'section'; // * + h2
  if (curTag === 'H3' || curTag === 'H4') return 'subsection'; // * + h3/h4
  if (prevTag === 'P' && curTag === 'P') return 'para'; // p + p
  if (prevTag === 'P' && (curTag === 'UL' || curTag === 'OL' || curTag === 'BLOCKQUOTE'))
    return 'para'; // p + ul/ol/blockquote
  return 'group'; // the default beat
}

// Sample pages: the internal audit page (every adjacency, once each)
// plus a spread of real pages across all four source packages.
const SAMPLE_SLUGS = [
  '_rhythm',
  'pyric-cli-tutorials-server-adoption',
  'pyric-firestore-how-to-pick-a-backend',
  'pyric-rules-explanation-agent-failure-modes',
  'pyric-sandbox-tutorials-01-your-first-sandbox-session',
  'pyric-storage-how-to-enforce-rules',
  'pyric-auth-reference-api',
  'pyric-database-reference-rules-tooling',
  'pyric-admin-firestore-how-to-run-a-transaction',
  'ui-firestore-documenteditor',
];

interface Violation {
  slug: string;
  index: number;
  prevTag: string;
  curTag: string;
  curText: string;
  adjacency: Adjacency;
  expected: number;
  actual: number;
}

const violations: Violation[] = [];
let pairsChecked = 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

for (const slug of SAMPLE_SLUGS) {
  const htmlPath = join(dist, 'docs', slug, 'index.html');
  if (!existsSync(htmlPath)) {
    console.error(`FAIL  sample page missing from dist: ${slug}`);
    process.exitCode = 1;
    continue;
  }
  await page.goto(`${base}/docs/${slug}/`);
  // Generated API reference pages set their own denser heading scale in
  // api-reference.css; the prose rhythm tokens deliberately do not apply.
  const isApiReference = await page.evaluate(
    () => document.querySelector('.prose') instanceof HTMLElement
      && document.querySelector('.prose')!.classList.contains('api-reference-body'),
  );
  if (isApiReference) {
    console.log(`  skip  ${slug}: api-reference page, measured by its own scale`);
    continue;
  }
  const measured = await page.evaluate(() => {
    const article = document.querySelector('.prose');
    if (!article) return { gaps: [], listGaps: [], quotePaddings: [] };
    const children = [...article.children] as HTMLElement[];
    const gaps: { prevTag: string; curTag: string; curText: string; gap: number }[] =
      [];
    for (let i = 1; i < children.length; i++) {
      const a = children[i - 1].getBoundingClientRect();
      const b = children[i].getBoundingClientRect();
      gaps.push({
        prevTag: children[i - 1].tagName,
        curTag: children[i].tagName,
        curText: (children[i].textContent ?? '').trim().slice(0, 40),
        gap: b.top - a.bottom,
      });
    }
    // li + li: the list beat, anywhere in the article (incl. nested).
    const listGaps: { curText: string; gap: number }[] = [];
    for (const li of article.querySelectorAll('li')) {
      const prev = li.previousElementSibling;
      if (!prev || prev.tagName !== 'LI') continue;
      listGaps.push({
        curText: (li.textContent ?? '').trim().slice(0, 40),
        gap: li.getBoundingClientRect().top - prev.getBoundingClientRect().bottom,
      });
    }
    // Blockquote internal breathing room (computed, not a sibling gap).
    const quotePaddings: { curText: string; top: number; bottom: number }[] = [];
    for (const bq of article.querySelectorAll('blockquote')) {
      const cs = getComputedStyle(bq);
      quotePaddings.push({
        curText: (bq.textContent ?? '').trim().slice(0, 40),
        top: parseFloat(cs.paddingTop),
        bottom: parseFloat(cs.paddingBottom),
      });
    }
    return { gaps, listGaps, quotePaddings };
  });

  const { gaps, listGaps, quotePaddings } = measured;
  for (let i = 0; i < gaps.length; i++) {
    const { prevTag, curTag, curText, gap } = gaps[i];
    const adjacency = classify(prevTag, curTag);
    const expected = TOKENS[adjacency];
    pairsChecked++;
    if (Math.abs(gap - expected) > 1) {
      violations.push({
        slug,
        index: i,
        prevTag,
        curTag,
        curText,
        adjacency,
        expected,
        actual: Math.round(gap * 100) / 100,
      });
    }
  }
  for (let i = 0; i < listGaps.length; i++) {
    const { curText, gap } = listGaps[i];
    pairsChecked++;
    if (Math.abs(gap - TOKENS.list) > 1) {
      violations.push({
        slug,
        index: i,
        prevTag: 'LI',
        curTag: 'LI',
        curText,
        adjacency: 'list',
        expected: TOKENS.list,
        actual: Math.round(gap * 100) / 100,
      });
    }
  }
  for (let i = 0; i < quotePaddings.length; i++) {
    const { curText, top, bottom } = quotePaddings[i];
    pairsChecked++;
    if (
      Math.abs(top - BLOCKQUOTE_PADDING_BLOCK) > 1 ||
      Math.abs(bottom - BLOCKQUOTE_PADDING_BLOCK) > 1
    ) {
      violations.push({
        slug,
        index: i,
        prevTag: 'BLOCKQUOTE',
        curTag: 'padding',
        curText,
        adjacency: 'para',
        expected: BLOCKQUOTE_PADDING_BLOCK,
        actual: Math.round(Math.max(top, bottom) * 100) / 100,
      });
    }
  }
  console.log(
    `  ok  ${slug}: ${gaps.length} pair(s), ${listGaps.length} list gap(s), ` +
      `${quotePaddings.length} quote(s) measured`,
  );
}

await browser.close();
server.stop();

console.log(`\n${pairsChecked} pair(s) checked across ${SAMPLE_SLUGS.length} page(s).`);

if (violations.length > 0) {
  console.error(`\n${violations.length} rhythm violation(s):`);
  for (const v of violations) {
    console.error(
      `  FAIL  ${v.slug} [${v.index}] ${v.prevTag}→${v.curTag} "${v.curText}": ` +
        `expected ${v.adjacency} (${v.expected}px), measured ${v.actual}px`,
    );
  }
  process.exit(1);
}

console.log('\nAll rhythm gaps match their token within 1px.');
