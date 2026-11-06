/**
 * The chip's Live tab: what the Sandbox tab shows in its place when the page
 * runs on a live host. Every fact comes from the host's health report
 * (`live` in `/__pyric/health`) or from the page itself:
 *
 * - Project: the projects the app's calls named, else the host's own.
 * - Clients: this page and its current identity. The host does not report
 *   other clients yet, so the rest of the list is an empty state.
 * - Coverage: the imports that pass through to production unobserved
 *   (`pyricLive({ passThrough })`). The host does not report the observed
 *   imports, so only the pass-through rows are listed.
 * - Billed this session: the host's billed call count.
 * - Page overlays and the Hide bar: the same controls as the Sandbox tab.
 */
import type { LiveHostStatus } from 'pyric/sandbox/internal';
import type { RuntimeIdentity } from './identity.js';
import { barHtml, buttonHtml, emptyHtml, escapeAttribute, iconHtml, rowHtml, sectionHtml, type ChipView } from './chip-markup.js';

/** What the Live tab reads from the page beside the host's status. */
export interface LiveViewContext {
  /** The page's current user, or null when signed out. */
  readonly user: RuntimeIdentity | null;
  /** Whether this page can show listener overlays, so the Theme editor applies. */
  readonly supportsListeners: boolean;
}

/** The tab strip's label for the sandbox tab on a live host. */
export const LIVE_TAB_LABEL = 'Live';

/** The Live tab's rules, drawn with the chip's existing tokens. */
export const LIVE_VIEW_STYLES = `
  [data-live-view] .row.full .c1.wide, [data-live-view] .row.full .s1.wide { grid-column: 1 / -1; }
  [data-live-view] .row.full .slot { display: none; }
  [data-live-view] .row.full .c1 { white-space: normal; }
  .row.project-row .c1.wide { white-space: normal; overflow-wrap: anywhere; text-overflow: clip; }
  .row.project-row .s1 { overflow: visible; }
  .client-row .c1 { display: flex; align-items: baseline; gap: var(--space-2); min-width: 0; }
  .client-kind { flex: none; }
  .live-tag { flex: none; padding: 0 var(--space-1); border: 1px solid #788fbd; border-radius: 4px; color: var(--pyric-accent); font-size: 10px; font-weight: 550; line-height: 16px; }
  .client-active { color: var(--pyric-muted); font-variant-numeric: tabular-nums; }
  .coverage-state { display: inline-flex; align-items: center; gap: var(--space-1); color: var(--pyric-muted); white-space: nowrap; }
  .coverage-state .icon { width: 12px; height: 12px; }
  .coverage-row .c1 { font-weight: 400; }
  .billed-line { display: inline-flex; flex-wrap: wrap; align-items: baseline; column-gap: var(--space-2); font-weight: 400; font-size: 12px; color: var(--pyric-muted); }
  .billed-line strong { color: var(--pyric-text); font-weight: 550; font-variant-numeric: tabular-nums; }
  .live-view { display: contents; }
`;

/** A section keyed by its data attribute, so a reader finds it without its copy. */
function keyed(section: string, key: string): string {
  return section.replace('<section class="section"', `<section class="section" data-live-section="${key}"`);
}

const CONSOLE_URL = 'https://console.firebase.google.com/project/';

/** The projects the app's calls go to: those its Firebase config named, else the host's. */
function liveProjects(live: LiveHostStatus): readonly string[] {
  return live.appProjectIds.length === 0 ? [live.configProjectId] : live.appProjectIds;
}

function projectRowHtml(projectId: string): string {
  const href = `${CONSOLE_URL}${encodeURIComponent(projectId)}/overview`;
  return rowHtml({
    c1: `<span class="mono">${escapeAttribute(projectId)}</span>`,
    s1: `<a class="nav-link" data-open-console href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">Open in console${iconHtml('external')}</a>`,
    slot: '',
    className: 'full sub project-row',
    attributes: `data-live-project="${escapeAttribute(projectId)}"`,
  });
}

function projectSectionHtml(live: LiveHostStatus): string {
  const rows = liveProjects(live).map(projectRowHtml).join('');
  return keyed(sectionHtml('Project', `<div class="rows">${rows}</div>`), 'project');
}

/** The user a row names: email, else display name, else nothing. */
function userLabel(user: RuntimeIdentity | null): string {
  return user?.email ?? user?.displayName ?? '';
}

function clientsSectionHtml(user: RuntimeIdentity | null): string {
  const label = userLabel(user);
  const self = rowHtml({
    c1: `<span class="client-kind">Browser tab</span><span class="live-tag">This page</span>`,
    s1: label === '' ? 'Signed out' : escapeAttribute(label),
    slot: '<span class="client-active">Now</span>',
    className: 'sub client-row self',
    attributes: `data-live-client="self" data-live-client-user="${escapeAttribute(label)}"`,
  });
  const others = emptyHtml('No other clients listed', 'Other tabs and server processes on this host are not listed yet.');
  return keyed(sectionHtml('Clients', `<div class="rows">${self}</div>${others}`), 'clients');
}

function coverageRowHtml(specifier: string): string {
  return rowHtml({
    c1: `<span class="mono">${escapeAttribute(specifier)}</span>`,
    s1: 'Goes to production. Still billed.',
    slot: `<span class="coverage-state">${iconHtml('unavailable')}<span>Not observed</span></span>`,
    className: 'coverage-row sub',
    attributes: `data-coverage-import="${escapeAttribute(specifier)}" data-coverage-state="not-observed"`,
  });
}

function coverageSectionHtml(live: LiveHostStatus): string {
  const passThrough = live.passThrough ?? [];
  const hasPassThrough = passThrough.length > 0;
  const body = hasPassThrough
    ? `<div class="rows">${passThrough.map(coverageRowHtml).join('')}</div>`
    : emptyHtml('No imports pass through', 'Every Firebase import this host serves is observed.');
  return keyed(sectionHtml('Coverage', body), 'coverage');
}

function billedSectionHtml(live: LiveHostStatus): string {
  const { reads, writes, deliveries } = live.billed;
  const count = (value: number) => `<strong>${value.toLocaleString()}</strong>`;
  const separator = '<span aria-hidden="true">·</span>';
  const line = `<span class="billed-line">${count(reads)} reads${separator}${count(writes)} writes${separator}${count(deliveries)} listener deliveries</span>`;
  const row = rowHtml({
    c1: line,
    slot: '',
    className: 'full',
    attributes: `data-live-billed data-billed-reads="${reads}" data-billed-writes="${writes}" data-billed-deliveries="${deliveries}"`,
  });
  return keyed(sectionHtml('Billed this session', `<div class="rows">${row}</div>`), 'billed');
}

function overlaysSectionHtml(supportsListeners: boolean): string {
  const hint = supportsListeners ? "Edit the overlay's custom properties" : 'Listener overlays are unavailable on this page';
  const theme = rowHtml({
    c1: 'Theme',
    s1: 'Colors and outlines for listeners',
    slot: buttonHtml(`data-open-overlay-theme${supportsListeners ? '' : ' disabled'}`, 'Edit', hint),
    attributes: 'data-theme-row',
  });
  return keyed(sectionHtml('Page overlays', `<div class="rows">${theme}</div>`), 'overlays');
}

/** The Live tab: project, clients, coverage, billed calls and overlays, with the Hide bar. */
export function liveViewHtml(live: LiveHostStatus, context: LiveViewContext): ChipView {
  const sections = [
    projectSectionHtml(live),
    clientsSectionHtml(context.user),
    coverageSectionHtml(live),
    billedSectionHtml(live),
    overlaysSectionHtml(context.supportsListeners),
  ];
  return {
    body: `<div class="live-view" data-live-view>${sections.join('')}</div>`,
    bar: barHtml([buttonHtml('data-dismiss-chip', 'Hide', 'Hide pyric on this page')], 'Hide until reload'),
  };
}
