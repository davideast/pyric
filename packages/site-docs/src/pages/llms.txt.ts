/**
 * /llms.txt — the agent-facing index of the docs site, generated at
 * build time from the docs content collection (same source as the nav
 * and the HTML routes; never hand-maintained).
 *
 * One line per public page: markdown link whose target is the page's
 * raw-markdown twin (/docs/<slug>.md) as a path-absolute URL, plus the
 * page's one-line description. Internal pages (/docs/_rhythm) are
 * excluded.
 */
import type { APIRoute } from 'astro';
import { publicDocs, docPath, firstParagraph } from '../lib/docs';

export const GET: APIRoute = async () => {
  const entries = await publicDocs();

  const lines = entries.map((entry) => {
    const desc = entry.data.description ?? firstParagraph(entry.body ?? '');
    return `- [${entry.data.title}](${docPath(entry)}.md)${desc ? `: ${desc}` : ''}`;
  });

  const body = [
    '# Pyric',
    '',
    '> Pyric is Firebase for agents: a Firebase-shaped SDK and toolchain',
    '> (in-browser sandbox, rules tooling, replay verification, deploy)',
    '> that lets developers and AI agents work against Firebase semantics',
    '> without touching a live project.',
    '',
    'Every page below is also served as raw markdown at the linked `.md` URL.',
    '',
    '## Docs',
    '',
    ...lines,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
