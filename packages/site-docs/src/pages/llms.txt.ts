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
import { publicDocs, docMdPath, firstParagraph } from '../lib/docs';

export const GET: APIRoute = async () => {
  const entries = await publicDocs();

  // One `##` section per nav group (source package/subtree), one line
  // per page — same order as the sidebar.
  const lines: string[] = [];
  let group = '';
  for (const entry of entries) {
    if (entry.data.group !== group) {
      group = entry.data.group;
      if (lines.length > 0) lines.push('');
      lines.push(`## ${group}`, '');
    }
    const desc = entry.data.description ?? firstParagraph(entry.body ?? '');
    lines.push(
      `- [${entry.data.title}](${docMdPath(entry)})${desc ? `: ${desc}` : ''}`,
    );
  }

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
    ...lines,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
