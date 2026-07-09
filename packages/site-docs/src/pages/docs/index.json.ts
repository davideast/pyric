/**
 * /docs/index.json — the search index Pyric Studio's finder ingests.
 * Built from the same content collection as the routes; the `shape`
 * field documents the contract in-band.
 */
import type { APIRoute } from 'astro';
import { publicDocs, slugOf, docPath, firstParagraph } from '../../lib/docs';
import { render } from 'astro:content';

export const GET: APIRoute = async () => {
  const entries = await publicDocs();

  const pages = [];
  for (const entry of entries) {
    const { headings } = await render(entry);
    pages.push({
      slug: slugOf(entry),
      path: docPath(entry),
      title: entry.data.title,
      section: entry.data.section,
      headings: headings
        .filter((h) => h.depth >= 2 && h.depth <= 3)
        .map((h) => ({ depth: h.depth, slug: h.slug, text: h.text })),
      excerpt: entry.data.description ?? firstParagraph(entry.body ?? ''),
    });
  }

  const index = {
    shape:
      'pages[]: { slug, path, title, section, headings[]: { depth, slug, text }, excerpt }. ' +
      'path is path-absolute and base-aware; a raw-markdown twin lives at `${path}.md`.',
    pages,
  };

  return new Response(JSON.stringify(index, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
