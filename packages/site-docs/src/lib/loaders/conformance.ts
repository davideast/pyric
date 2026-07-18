/**
 * Content-layer loader for the conformance pages. The site is a consumer of
 * the published docs projection (`@pyric/cli/conformance/docs`): pages were
 * fully rendered from the central model at package build; this loader applies
 * the site-side table presentation and stores them. No model derivation
 * happens here — a load is milliseconds.
 */
import type { Loader } from 'astro/loaders';
import { transformCompatTables } from '../compat-tables';
import { nativeImport } from '../native-import';

/** The scoreboard's per-page back-links are emitted as `.md`-relative by the
 * renderer; route them at the scoreboard's public URL. */
function rewriteConformanceLinks(body: string): string {
  return body.replace(
    /\]\((?:\.\.\/)*[\w./-]*conformance\/SCORES\.md\)/g,
    '](../conformance-scores/)',
  );
}

export function conformanceLoader(): Loader {
  return {
    name: 'pyric-conformance',
    async load({ store, renderMarkdown }) {
      let pages;
      try {
        ({ CONFORMANCE_DOCS_PAGES: pages } = await nativeImport<typeof import('@pyric/cli/conformance/docs')>('@pyric/cli/conformance/docs'));
      } catch (cause) {
        throw new Error(
          'conformance loader: packages are not built (missing @pyric/cli/conformance/docs).\n' +
            'Build packages first, from the repo root:\n\n  bun run build --packages-only\n' +
            `\nunderlying: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      store.clear();
      let order = 0;
      for (const page of pages) {
        order += 10;
        const body = transformCompatTables(rewriteConformanceLinks(page.markdown));
        store.set({
          id: page.slug,
          data: {
            title: page.title,
            ...(page.label !== page.title ? { navLabel: page.label } : {}),
            group: 'Conformance',
            section: '',
            order,
            kind: 'page',
            internal: false,
          },
          body,
          rendered: await renderMarkdown(body),
        });
      }
    },
  };
}
