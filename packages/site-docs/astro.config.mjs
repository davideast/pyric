import { readFileSync } from 'node:fs';
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import {
  NODE_BUILTIN_RE,
  NODE_BUILTIN_SHIMS,
  pyric,
} from '@pyric/cli/vite';

// Security Rules TextMate grammar — Shiki has no built-in language for
// Firestore rules, so code fences tagged ```rules use this one.
const firestoreRules = JSON.parse(
  readFileSync(new URL('./src/lib/firestore-rules.tmLanguage.json', import.meta.url), 'utf8'),
);
import rehypeDocs from './src/lib/rehype-docs.mjs';
import remarkDocLinks from './src/lib/remark-doc-links.ts';

function clientNodeBuiltinShims() {
  const prefix = '\0pyric-site-node-shim:';
  return {
    name: 'pyric-site-node-builtin-shims',
    enforce: 'pre',
    resolveId(source, _importer, options) {
      if (options?.ssr) return null;
      const match = NODE_BUILTIN_RE.exec(source);
      return match ? prefix + match[2] : null;
    },
    load(id) {
      return id.startsWith(prefix) ? NODE_BUILTIN_SHIMS[id.slice(prefix.length)] : null;
    },
  };
}

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
  integrations: [react()],
  vite: {
    plugins: [
      pyric({ ui: true, capture: false }),
      clientNodeBuiltinShims(),
      tailwindcss(),
    ],
    resolve: { dedupe: ['react', 'react-dom'] },
    define: {
      'import.meta.env.STUDIO_STATIC': JSON.stringify(process.env.STUDIO_STATIC === '1'),
    },
  },
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
    remarkPlugins: [remarkDocLinks],
    rehypePlugins: [rehypeDocs],
    shikiConfig: {
      theme: 'one-dark-pro',
      wrap: false,
      langs: [{ ...firestoreRules, aliases: ['rules'] }],
    },
  },
});
