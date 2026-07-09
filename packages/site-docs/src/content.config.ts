import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * The docs content collection. One markdown file per page under
 * src/content/docs/; the file name is the route slug
 * (`get-started.md` → /docs/get-started).
 *
 * Front matter:
 * - `title`    — page + nav title.
 * - `section`  — nav group heading (pages are grouped by it, ordered
 *                by first appearance via `order`).
 * - `order`    — sort key within the whole nav.
 * - `description` — one-liner used by llms.txt and index.json.
 * - `internal` — excluded from nav, llms.txt, and index.json (the
 *                /docs/_rhythm audit page). Still gets a route + twin.
 * - `slug`     — route slug override. Needed for /docs/_rhythm: the
 *                glob loader skips `_`-prefixed files, so the source
 *                file is rhythm.md with `slug: _rhythm`.
 */
const docs = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/docs' }),
  schema: z.object({
    title: z.string(),
    section: z.string(),
    order: z.number(),
    description: z.string().optional(),
    internal: z.boolean().default(false),
    slug: z.string().optional(),
  }),
});

export const collections = { docs };
