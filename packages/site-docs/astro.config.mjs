import { defineConfig } from 'astro/config';
import rehypeDocs from './src/lib/rehype-docs.mjs';

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
  // `directory` format emits every doc page as `<slug>/index.html`, so
  // the page is reachable at the host-agnostic `/docs/<slug>/` on any
  // dumb static host (no server-side extension/rewrite rules needed —
  // `file` format's `/docs/<slug>.html` requires either a host that
  // serves extensionless paths or a rewrite). The .md agent twin stays
  // FLAT at `/docs/<slug>.md` (it's an API route, not a content page —
  // llms.txt links point at the flat form) — see [slug].md.ts.
  build: { format: 'directory' },
  markdown: {
    // Build-time HTML transforms: external links open in a new tab
    // with an arrow indicator; tables get an overflow-x scroll wrapper.
    // See src/lib/rehype-docs.mjs.
    rehypePlugins: [rehypeDocs],
    shikiConfig: {
      theme: 'one-dark-pro',
      wrap: false,
    },
  },
});
