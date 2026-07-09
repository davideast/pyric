import { defineConfig } from 'astro/config';

/**
 * Pyric docs — a pure-SSG Astro site, deliberately a *sibling* of the
 * playground app rather than routes inside it.
 *
 * Why not inside packages/playground: its astro.config fetches a
 * deployed Firebase site's init.json at config-resolution time (docs
 * builds would require network), registers the @astrojs/node adapter,
 * and applies client-only node-shim / process.env-rewrite Vite plugins
 * to every client bundle. Docs need none of that. This config is the
 * whole build: markdown content collection in, static HTML out.
 *
 * Composition contract with the future hosted Pyric Studio site:
 * - `DOCS_BASE` sets the base path (e.g. `/studio`), same pattern the
 *   playground uses with `PLAYGROUND_BASE`. Every internal link and
 *   generated URL (llms.txt, index.json) respects it.
 * - Output is plain static files — `dist/` can be copied under any
 *   static host or merged into a larger static site.
 *
 * Code highlighting: the playground has no Shiki — its editor uses
 * @codemirror/theme-one-dark and its rendered code blocks are plain
 * <pre> on bg #0f0f17. `one-dark-pro` is Shiki's port of that same
 * One Dark theme; the background is overridden to the playground's
 * exact #0f0f17 in docs.css so blocks match the product chrome.
 */
export default defineConfig({
  output: 'static',
  base: process.env.DOCS_BASE ?? '/',
  // `file` format keeps every doc page a sibling of its .md twin
  // (/docs/x.html next to /docs/x.md), so in-content links can be
  // sibling-relative (`[CLI reference](cli)`) — they resolve from both
  // the HTML page and the raw twin, under any base path.
  build: { format: 'file' },
  markdown: {
    shikiConfig: {
      theme: 'one-dark-pro',
      wrap: false,
    },
  },
});
