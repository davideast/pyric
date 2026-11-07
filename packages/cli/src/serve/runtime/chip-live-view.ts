/**
 * The chip's Live tab: what the Sandbox tab shows in its place when the page
 * runs on a live host. Every fact comes from the host's health report
 * (`live` in `/__pyric/health`) or from the page itself:
 *
 * - Project: the projects the app's calls named, else the host's own.
 * - Clients: this page first, then every other client the host lists
 *   (`live.clients`): another browser profile, a service worker, a Node
 *   process. The host keys a browser client by its profile id, so the tabs
 *   of this page's profile are this page's row.
 * - Coverage: the imports that pass through to production unobserved
 *   (`pyricLive({ passThrough })`), then the imports the host observes
 *   (`live.observed`).
 * - Billed this session: the host's billed call count.
 * - Page overlays and the Hide bar: the same controls as the Sandbox tab.
 */
import type { LiveHostStatus } from 'pyric/sandbox/internal';
import { barHtml, buttonHtml, escapeAttribute, iconHtml, pluralize, rowHtml, sectionHtml, type ChipView } from './chip-markup.js';

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];

/** What the Live tab reads from the page beside the host's status. */
export interface LiveViewContext {
  /** This page's browser profile id: the client id the host lists it by. */
  readonly selfClientId: string;
  /** The page's clock, in epoch milliseconds, to say when each client was last heard from. */
  readonly now: number;
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
  .client-where { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--pyric-muted); font-size: 11px; font-weight: 400; }
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

const NOW_SECONDS = 5;

/** When a client was last heard from: `Now`, `8s ago`, `5 min ago`. */
export function clientActiveText(lastSeen: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - lastSeen) / 1000));
  const isNow = seconds < NOW_SECONDS;
  if (isNow) return 'Now';
  const isUnderAMinute = seconds < 60;
  return isUnderAMinute ? `${seconds}s ago` : `${Math.floor(seconds / 60)} min ago`;
}

/** Each kind as its row names it. A browser client other than this page's is another profile. */
export const CLIENT_KIND_LABELS: Readonly<Record<LiveClient['kind'], string>> = {
  browser: 'Browser tab, other profile',
  'service-worker': 'Service worker',
  node: 'Node process',
};

/** The order clients list in: browser profiles, then service workers, then Node processes. */
const KIND_ORDER: readonly LiveClient['kind'][] = ['browser', 'service-worker', 'node'];

/** The user a client row names: the email its page reported, else the uid its calls ran as; empty when signed out. */
function clientUser(client: LiveClient | undefined): string {
  return client?.email ?? client?.user ?? '';
}

interface ClientRow {
  readonly key: string;
  readonly kind: string;
  readonly where: string;
  readonly user: string;
  readonly active: string;
  readonly isSelf: boolean;
}

function clientRowHtml(row: ClientRow): string {
  const second = row.isSelf
    ? '<span class="live-tag">This page</span>'
    : `<span class="client-where mono">${escapeAttribute(row.where)}</span>`;
  return rowHtml({
    c1: `<span class="client-kind">${escapeAttribute(row.kind)}</span>${second}`,
    s1: row.user === '' ? 'Signed out' : escapeAttribute(row.user),
    slot: `<span class="client-active">${escapeAttribute(row.active)}</span>`,
    className: `sub client-row${row.isSelf ? ' self' : ''}`,
    title: `${row.kind} ${row.where}`,
    attributes: `data-live-client="${escapeAttribute(row.key)}" data-live-client-user="${escapeAttribute(row.user)}"`,
  });
}

function isSelfClient(client: LiveClient, selfClientId: string): boolean {
  return client.kind === 'browser' && client.clientId === selfClientId;
}

/** The clients the host lists other than this page, in kind order. */
function otherClients(clients: readonly LiveClient[], selfClientId: string): LiveClient[] {
  const others = clients.filter((client) => !isSelfClient(client, selfClientId));
  return KIND_ORDER.flatMap((kind) => others.filter((client) => client.kind === kind));
}

function otherClientRow(client: LiveClient, now: number): ClientRow {
  return {
    key: client.kind,
    kind: CLIENT_KIND_LABELS[client.kind],
    where: client.label ?? '',
    user: clientUser(client),
    active: clientActiveText(client.lastSeen, now),
    isSelf: false,
  };
}

function clientsSectionHtml(live: LiveHostStatus, context: LiveViewContext): string {
  const clients = live.clients ?? [];
  const selfEntry = clients.find((client) => isSelfClient(client, context.selfClientId));
  const self: ClientRow = { key: 'self', kind: 'Browser tab', where: selfEntry?.label ?? '', user: clientUser(selfEntry), active: 'Now', isSelf: true };
  const rows = [self, ...otherClients(clients, context.selfClientId).map((client) => otherClientRow(client, context.now))];
  const meta = pluralize(rows.length, 'connected', 'connected');
  return keyed(sectionHtml('Clients', `<div class="rows">${rows.map(clientRowHtml).join('')}</div>`, meta), 'clients');
}

function coverageRowHtml(specifier: string, isObserved: boolean): string {
  const state = isObserved ? 'observed' : 'not-observed';
  const stateLabel = isObserved ? 'Observed' : 'Not observed';
  const consequence = isObserved ? {} : { s1: 'Goes to production. Still billed.' };
  return rowHtml({
    c1: `<span class="mono">${escapeAttribute(specifier)}</span>`,
    ...consequence,
    slot: `<span class="coverage-state">${iconHtml(isObserved ? 'check' : 'unavailable')}<span>${stateLabel}</span></span>`,
    className: `coverage-row${isObserved ? '' : ' sub'}`,
    attributes: `data-coverage-import="${escapeAttribute(specifier)}" data-coverage-state="${state}"`,
  });
}

function coverageSectionHtml(live: LiveHostStatus): string {
  const passThrough = live.passThrough ?? [];
  const observed = live.observed ?? [];
  const rows = [
    ...passThrough.map((specifier) => coverageRowHtml(specifier, false)),
    ...observed.map((specifier) => coverageRowHtml(specifier, true)),
  ];
  const meta = `${observed.length} of ${passThrough.length + observed.length} observed`;
  return keyed(sectionHtml('Coverage', `<div class="rows">${rows.join('')}</div>`, meta), 'coverage');
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
    clientsSectionHtml(live, context),
    coverageSectionHtml(live),
    billedSectionHtml(live),
    overlaysSectionHtml(context.supportsListeners),
  ];
  return {
    body: `<div class="live-view" data-live-view>${sections.join('')}</div>`,
    bar: barHtml([buttonHtml('data-dismiss-chip', 'Hide', 'Hide pyric on this page')], 'Hide until reload'),
  };
}
