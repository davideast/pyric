/**
 * The "From" select chip Traffic and Rates read on a live host: whose calls
 * they list and count. The scope rule, its option values and its user and
 * client options are the shared `client-scope` rule Studio's Traffic reads
 * too (`pyric/sandbox/internal`); this file names the chip's own options
 * and draws its select.
 *
 * The chip is a page, so it offers "From this page" and lists every client
 * other than this page's browser profile, which it names "other profile".
 */
import {
  AGENTS_SCOPE_LABEL, CALLER_SOURCE_LABELS, EVERY_CLIENT_SCOPE, LIVE_CLIENT_CALLER_KINDS, PAGE_SCOPE, clientScopeOptions, inClientScope,
  isAgentCall, keepChosenOption, liveClientEmails, scopeClients, scopeFromValue, scopeValue, withClientLabel,
  type CallerSource, type ClientScope, type LiveHostStatus, type ScopedEventFields, type ScopeOption, type ScopeOptions,
} from 'pyric/sandbox/internal';
import { CLIENT_KIND_LABELS } from './chip-live-view.js';

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];

/** Whose calls a view lists or counts. */
export type ChipScope = ClientScope;

/** The fields of a row or an event a scope reads. */
export type ChipScopeFields = ScopedEventFields;

export { EVERY_CLIENT_SCOPE, PAGE_SCOPE, scopeFromValue, scopeValue, type ScopeOption, type ScopeOptions };

/** Each client kind as an option names it, after "From". */
const OPTION_KIND_LABELS: Readonly<Record<LiveClient['kind'], string>> = {
  browser: 'browser tab, other profile',
  'service-worker': 'service worker',
  node: 'Node process',
};

/**
 * Whether a row or event is in `scope`, as the page whose id is
 * `viewerPageId` reads it.
 */
export function inChipScope(fields: ChipScopeFields, scope: ChipScope, viewerPageId: string | undefined): boolean {
  return inClientScope(fields, scope, viewerPageId);
}

/**
 * The select's client and user options: every client the host lists other
 * than this page's profile, then Studio and agents; every distinct uid the
 * clients and `seenUsers` name, then signed-out calls.
 */
export function scopeOptions(clients: readonly LiveClient[], selfClientId: string, seenUsers: Iterable<string>): ScopeOptions {
  return clientScopeOptions(clients, { kindLabels: OPTION_KIND_LABELS, selfClientId }, seenUsers);
}

/**
 * The select: this page, every client, then the Clients and Users groups.
 * A scope whose option is gone (a client that disconnected) keeps the
 * option it was chosen from, so the select still names what it shows.
 */
export function scopeSelectHtml(attribute: string, scope: ChipScope, options: ScopeOptions, chosen: ScopeOption | null, escape: (value: string) => string): string {
  const selected = scopeValue(scope);
  const { clients, users } = keepChosenOption(options, selected, chosen);
  const option = (entry: ScopeOption) => `<option value="${escape(entry.value)}"${entry.value === selected ? ' selected' : ''}>${escape(entry.label)}</option>`;
  const fixed = [{ value: 'page', label: 'From this page' }, { value: 'all', label: 'From every client' }].map(option).join('');
  return `<select ${attribute} aria-label="Requests from">${fixed}<optgroup label="Clients">${clients.map(option).join('')}</optgroup><optgroup label="Users">${users.map(option).join('')}</optgroup></select>`;
}

/**
 * What Rates' Scope fact reads for `scope` on a live host: this page, all
 * clients, the client by its kind and label, Studio and agents, the user by
 * the email its client reported or its uid, or signed-out calls. A client
 * no longer listed reads as the option it was chosen from.
 */
export function scopeLabel(scope: ChipScope, clients: readonly LiveClient[], chosen: ScopeOption | null): string {
  if (scope.kind === 'page') return CALLER_SOURCE_LABELS.page;
  if (scope.kind === 'all') return 'All clients';
  if (scope.kind === 'agents') return AGENTS_SCOPE_LABEL;
  if (scope.kind === 'user') return scope.user === null ? 'Signed-out calls' : liveClientEmails(clients).get(scope.user) ?? scope.user;
  const client = scope.client;
  const listed = clients.find((entry) => entry.clientId === client.clientId && LIVE_CLIENT_CALLER_KINDS[entry.kind] === client.kind);
  if (listed !== undefined) return withClientLabel(CLIENT_KIND_LABELS[listed.kind], listed.label);
  const kept = chosen?.value === scopeValue(scope) ? chosen.label.replace(/^From /, '') : client.clientId;
  return kept.charAt(0).toUpperCase() + kept.slice(1);
}

/**
 * The source a row reads on a live host: this page, the listed client that
 * sent it, by kind and label, Studio and agents for a call no client sent,
 * and otherwise the source's own label.
 */
export function liveSourceLabel(fields: ChipScopeFields, source: CallerSource, clients: readonly LiveClient[], selfClientId: string): string {
  if (source === 'page') return CALLER_SOURCE_LABELS.page;
  if (isAgentCall(fields)) return AGENTS_SCOPE_LABEL;
  const caller = fields.caller;
  const listed = scopeClients(clients, selfClientId).find((client) => caller?.clientId === client.clientId && caller.kind === LIVE_CLIENT_CALLER_KINDS[client.kind]);
  return listed === undefined ? CALLER_SOURCE_LABELS[source] : withClientLabel(CLIENT_KIND_LABELS[listed.kind], listed.label);
}
