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
 * One static Astro tree owns both documentation and the Studio shell. Studio
 * service entries hydrate the shared React application; documentation remains
 * static HTML and starts no SharedWorker. `DOCS_BASE` selects `/` for the
 * public site or `/__pyric/ui/` for the tree embedded in @pyric/cli.
 *
 * The browser shims apply only to Studio's client graph. Code highlighting
 * uses `one-dark-pro`, aligned with the Studio editor palette.
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
