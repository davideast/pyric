/**
 * Content-layer loader for the generated API reference. One in-process
 * TypeDoc conversion covers every released entry point (src/lib/api-reference).
 * The loader digests every declaration in each published package and skips the
 * conversion when the digest set matches the persisted store. A warm dev start
 * does not run TypeDoc.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Loader } from 'astro/loaders';
import {
  discoverApiDescriptors,
  REPO_ROOT,
  renderAllApiPages,
} from '../api-reference';

/** Bumping this invalidates every cached entry (renderer/config changes). */
const GENERATOR_VERSION = 'v2';

function declarationFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...declarationFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.d.ts')) files.push(path);
  }
  return files.sort();
}

function packageDeclarationDigest(packageDir: string): string {
  const distDir = join(REPO_ROOT, 'packages', packageDir, 'dist');
  const files = declarationFiles(distDir);
  if (files.length === 0) {
    throw new Error(`api-reference loader: no declarations found in ${distDir}`);
  }
  const hash = createHash('sha256').update(GENERATOR_VERSION);
  for (const file of files) {
    hash.update(relative(distDir, file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

export function apiReferenceLoader(): Loader {
  return {
    name: 'pyric-api-reference',
    async load({ store, renderMarkdown, logger }) {
      const descriptors = discoverApiDescriptors();
      const digests = new Map<string, string>();
      const packageDigests = new Map<string, string>();
      for (const d of descriptors) {
        try {
          readFileSync(d.typesPath);
        } catch {
          throw new Error(
            'api-reference loader: packages are not built (missing ' +
              d.typesPath +
              ').\nBuild packages first, from the repo root:\n\n  bun run build --packages-only\n',
          );
        }
        let packageDigest = packageDigests.get(d.packageDir);
        if (!packageDigest) {
          packageDigest = packageDeclarationDigest(d.packageDir);
          packageDigests.set(d.packageDir, packageDigest);
        }
        digests.set(
          d.slug,
          createHash('sha256')
            .update(packageDigest)
            .update(relative(REPO_ROOT, d.typesPath))
            .digest('hex'),
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
