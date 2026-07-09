/**
 * Agent twin: every /docs/<slug> page also serves /docs/<slug>.md —
 * the raw markdown of the same content entry, exact bytes of the
 * source file after the front-matter block is stripped. Read from the
 * entry's filePath rather than the loader's `body` because the glob
 * loader trims surrounding whitespace; the twin promises exact bytes.
 * Generated from the same collection as the HTML routes; nothing
 * hand-maintained.
 */
import { readFileSync } from 'node:fs';
import type { APIRoute, GetStaticPaths } from 'astro';
import { allDocs, slugOf, type DocEntry } from '../../lib/docs';

export const getStaticPaths: GetStaticPaths = async () => {
  const entries = await allDocs();
  return entries.map((entry) => ({
    params: { slug: slugOf(entry) },
    props: { entry },
  }));
};

const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

export const GET: APIRoute<{ entry: DocEntry }> = ({ props }) => {
  const raw = readFileSync(props.entry.filePath!, 'utf8');
  return new Response(raw.replace(FRONT_MATTER, ''), {
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
  });
};
