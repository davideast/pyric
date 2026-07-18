/**
 * Content-layer loader for the generated API reference. One in-process
 * TypeDoc conversion covers every released entry point (src/lib/api-reference)
 * — but only when a declaration actually changed: the loader digests every
 * entry's .d.ts up front and skips the conversion entirely when the digest
 * set matches the persisted store. Warm dev start: no TypeDoc at all.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Loader } from 'astro/loaders';
import {
  discoverApiDescriptors,
  renderAllApiPages,
} from '../api-reference';

/** Bumping this invalidates every cached entry (renderer/config changes). */
const GENERATOR_VERSION = 'v1';

export function apiReferenceLoader(): Loader {
  return {
    name: 'pyric-api-reference',
    async load({ store, renderMarkdown, logger }) {
      const descriptors = discoverApiDescriptors();
      const digests = new Map<string, string>();
      for (const d of descriptors) {
        let declarations: string;
        try {
          declarations = readFileSync(d.typesPath, 'utf8');
        } catch {
          throw new Error(
            'api-reference loader: packages are not built (missing ' +
              d.typesPath +
              ').\nBuild packages first, from the repo root:\n\n  bun run build --packages-only\n',
          );
        }
        digests.set(
          d.slug,
          createHash('sha256').update(GENERATOR_VERSION).update(declarations).digest('hex'),
        );
      }
      // The index digests the whole inventory (routes + order), so adding or
      // removing an export re-renders it.
      digests.set(
        'api-reference',
        createHash('sha256')
          .update(GENERATOR_VERSION)
          .update(JSON.stringify(descriptors.map((d) => d.slug)))
          .digest('hex'),
      );

      const ids = new Set(digests.keys());
      const fresh =
        store.keys().length === ids.size &&
        [...ids].every((id) => store.get(id)?.digest === digests.get(id));
      if (fresh) {
        logger.info(`API reference unchanged (${descriptors.length} routes, cached)`);
        return;
      }

      const started = Date.now();
      const pages = await renderAllApiPages();
      store.clear();
      for (const page of pages) {
        store.set({
          id: page.slug,
          data: page.data,
          body: page.body,
          rendered: await renderMarkdown(page.body),
          digest: digests.get(page.slug),
        });
      }
      logger.info(
        `API reference rendered (${descriptors.length} routes, ${Date.now() - started}ms)`,
      );
    },
  };
}
