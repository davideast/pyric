/**
 * Agent twin: every /docs/<slug> page also serves /docs/<slug>.md —
 * the raw markdown of the same content entry. Authored pages serve the
 * exact bytes of the source file after the front-matter block (the glob
 * loader trims surrounding whitespace; the twin promises exact bytes).
 * Loader-backed generated pages (conformance, API reference) have no
 * source file — their body IS the source, so it serves directly.
 */
import { existsSync, readFileSync } from 'node:fs';
import type { APIRoute, GetStaticPaths } from 'astro';
import { allDocs, slugOf, type DocEntry } from '../../lib/content';

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await allDocs();
  return entries.map((entry) => ({
    params: { slug: slugOf(entry) },
    props: { entry },
  }));
};

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

export const GET: APIRoute<{ entry: DocEntry }> = ({ props }) => {
  const source = existsSync(props.entry.filePath)
    ? readFileSync(props.entry.filePath, 'utf8').replace(FRONT_MATTER, '')
    : props.entry.body;
  return new Response(source, {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
