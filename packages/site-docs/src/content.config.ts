/**
 * Content collections for GENERATED pages only. Authored docs are plain
 * markdown discovered by import.meta.glob (src/lib/content.ts) — no schema
 * layer for files. These two collections are data: the site consuming the
 * published conformance model and the TypeDoc reflection through loaders,
 * with Astro's persisted store providing the caching.
 */
import { defineCollection } from 'astro:content';
import { conformanceLoader } from './lib/loaders/conformance';
import { apiReferenceLoader } from './lib/loaders/api-reference';

export const collections = {
  conformance: defineCollection({ loader: conformanceLoader() }),
  apiReference: defineCollection({ loader: apiReferenceLoader() }),
};
