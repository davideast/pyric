/**
 * The served copy's status page, at `STATUS_PATH` on the served copy's own
 * host and port (`status-route.ts`): plain HTML that says which commit is
 * served, what changed since the commit served before it, and which gates
 * it fails. It is built from the served process's own commit and
 * `last-served.json`, read on each request; a record for another commit is
 * not shown as this one's.
 */
import type { LastServed } from './last-served.ts';

export const STATUS_PATH = '/_factory/status';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

const short = (commit: string) => commit.slice(0, 12);

function failingSection(record: LastServed): string {
  if (record.failing.length === 0) return '<p>None. Every gate passed.</p>';
  return list(record.failing);
}

function list(items: readonly string[]): string {
  return `<ul>\n${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('\n')}\n</ul>`;
}

function sinceHeading(since: LastServed['since']): string {
  const what = since.what === 'previous' ? 'the previously served commit' : 'the run\'s start commit';
  return `Changes since ${what}, <code>${escapeHtml(short(since.commit))}</code>`;
}

function changesSection(record: LastServed): string {
  if (record.changes === undefined) return '<p>The commits could not be listed.</p>';
  if (record.changes.length === 0) return '<p>No new commits.</p>';
  return list(record.changes);
}

function page(body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Served build</title></head>',
    '<body>',
    '<h1>Served build</h1>',
    body,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/** The page for the served process's `commit`, with its record when the record is for that commit. */
export function statusPage(commit: string, record: LastServed | undefined): string {
  const served = `Commit <code>${escapeHtml(short(commit))}</code>`;
  const isThisCommit = record !== undefined && record.commit === commit;
  if (!isThisCommit) return page(`<p>${served}</p>\n<p>No check has recorded this commit yet.</p>`);
  return page([
    `<p>${served}, checked in hour ${record.hour} at ${escapeHtml(record.at)}</p>`,
    '<h2>Failing gates</h2>',
    failingSection(record),
    `<h2>${sinceHeading(record.since)}</h2>`,
    changesSection(record),
  ].join('\n'));
}
