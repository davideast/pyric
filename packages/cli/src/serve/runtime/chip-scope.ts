/**
 * The "From" select chip Traffic and Rates read on a live host: whose calls
 * they list and count.
 *
 * - This page: the viewing page's own calls, as the sandbox's page scope.
 * - Every client: everything the host received.
 * - One client the host lists (`live.clients`), other than this page's
 *   browser profile: its calls, by kind and client id (`eventScope`).
 * - Studio and agents: calls with no client id, which no client listed
 *   sent: Studio, MCP and server admin code the bridge relays.
 * - One user: calls that ran as a uid (`eventScope`), and signed-out calls.
 *
 * A user option is named by the email a client's page reported for that
 * uid, else by the uid. The email stays in this page: the value an option
 * carries, and everything the scope filters on, is the uid.
 */
import { callerSource, CALLER_SOURCE_LABELS, eventScope, type CallerSource, type LiveHostStatus, type ScopeClient } from 'pyric/sandbox/internal';
import type { EventCaller } from 'pyric/sandbox';
import { CLIENT_KIND_LABELS } from './chip-live-view.js';

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];

/** Whose calls a view lists or counts. */
export type ChipScope =
  | { kind: 'page' }
  | { kind: 'all' }
  | { kind: 'client'; client: ScopeClient }
  | { kind: 'agents' }
  | { kind: 'user'; user: string | null };

/** The fields of a row or an event a scope reads. */
export interface ChipScopeFields {
  caller?: EventCaller;
  auth?: { uid: string } | null;
}

export const PAGE_SCOPE: ChipScope = { kind: 'page' };
export const EVERY_CLIENT_SCOPE: ChipScope = { kind: 'all' };

/** The event caller kind each listed client kind stamps. */
const CALLER_KINDS: Readonly<Record<LiveClient['kind'], EventCaller['kind']>> = {
  browser: 'page',
  'service-worker': 'service-worker',
  node: 'node',
};

/** Each client kind as an option names it, after "From". */
const OPTION_KIND_LABELS: Readonly<Record<LiveClient['kind'], string>> = {
  browser: 'browser tab, other profile',
  'service-worker': 'service worker',
  node: 'Node process',
};

/** The order clients list in, as the Live tab lists them. */
const KIND_ORDER: readonly LiveClient['kind'][] = ['browser', 'service-worker', 'node'];

const AGENTS_LABEL = 'Studio and agents';

/** The value an option carries for `scope`. */
export function scopeValue(scope: ChipScope): string {
  if (scope.kind === 'client') return `client:${scope.client.kind}:${scope.client.clientId}`;
  if (scope.kind === 'user') return scope.user === null ? 'signed-out' : `user:${scope.user}`;
  return scope.kind;
}

/** The scope an option's value names, or null for a value no option carries. */
export function scopeFromValue(value: string): ChipScope | null {
  const fixed: Record<string, ChipScope> = { page: PAGE_SCOPE, all: EVERY_CLIENT_SCOPE, agents: { kind: 'agents' }, 'signed-out': { kind: 'user', user: null } };
  const known = fixed[value];
  if (known !== undefined) return known;
  if (value.startsWith('user:')) return { kind: 'user', user: value.slice('user:'.length) };
  const client = /^client:([^:]+):(.+)$/.exec(value);
  if (client === null) return null;
  return { kind: 'client', client: { kind: client[1] as EventCaller['kind'], clientId: client[2]! } };
}

/** Whether a row is this page's own: what the sandbox's page scope keeps. */
function isThisPage(source: CallerSource | undefined): boolean {
  return source === undefined || source === 'page' || source === 'unknown';
}

/** A call no listed client sent: a caller with no client id that is not this page. */
function isAgentCall(fields: ChipScopeFields): boolean {
  const caller = fields.caller;
  return caller !== undefined && caller.clientId === undefined && caller.kind !== 'page';
}

/**
 * Whether a row or event is in `scope`, as the page whose id is
 * `viewerPageId` reads it. `source` is the row's source when the caller
 * already read it; an event reads it from its caller.
 */
export function inChipScope(fields: ChipScopeFields, scope: ChipScope, viewerPageId: string | undefined): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'page') {
    const source = fields.caller === undefined ? undefined : callerSource(fields.caller, viewerPageId);
    return isThisPage(source);
  }
  if (scope.kind === 'agents') return isAgentCall(fields);
  if (scope.kind === 'client') return eventScope(fields, { client: scope.client });
  return eventScope(fields, { user: scope.user });
}

function isSelfClient(client: LiveClient, selfClientId: string): boolean {
  return client.kind === 'browser' && client.clientId === selfClientId;
}

/** The clients the host lists other than this page's profile, in the Live tab's order. */
function otherClients(clients: readonly LiveClient[], selfClientId: string): LiveClient[] {
  const others = clients.filter((client) => !isSelfClient(client, selfClientId));
  return KIND_ORDER.flatMap((kind) => others.filter((client) => client.kind === kind));
}

function withLabel(kind: string, label: string | undefined): string {
  return label === undefined || label === '' ? kind : `${kind} ${label}`;
}

/** One option of the select. */
export interface ScopeOption {
  readonly value: string;
  readonly label: string;
}

/** What the select lists beside its two fixed options. */
export interface ScopeOptions {
  readonly clients: readonly ScopeOption[];
  readonly users: readonly ScopeOption[];
}

function clientOption(client: LiveClient): ScopeOption {
  const scope: ChipScope = { kind: 'client', client: { kind: CALLER_KINDS[client.kind], clientId: client.clientId } };
  return { value: scopeValue(scope), label: `From ${withLabel(OPTION_KIND_LABELS[client.kind], client.label)}` };
}

/** The email each uid's client reported, the first one listed. */
function emailsByUser(clients: readonly LiveClient[]): Map<string, string> {
  const emails = new Map<string, string>();
  for (const client of clients) {
    const named = client.user !== null && client.email !== undefined && !emails.has(client.user);
    if (named) emails.set(client.user!, client.email!);
  }
  return emails;
}

/**
 * The select's client and user options: every client the host lists other
 * than this page's profile, then Studio and agents; every distinct uid the
 * clients and `seenUsers` name, then signed-out calls.
 */
export function scopeOptions(clients: readonly LiveClient[], selfClientId: string, seenUsers: Iterable<string>): ScopeOptions {
  const clientOptions = otherClients(clients, selfClientId).map(clientOption);
  const emails = emailsByUser(clients);
  const uids = new Set<string>();
  for (const client of clients) if (client.user !== null) uids.add(client.user);
  for (const uid of seenUsers) uids.add(uid);
  const users = [...uids].map((uid) => ({ value: scopeValue({ kind: 'user', user: uid }), label: `From ${emails.get(uid) ?? uid}` }));
  return {
    clients: [...clientOptions, { value: 'agents', label: `From ${AGENTS_LABEL}` }],
    users: [...users, { value: 'signed-out', label: 'From signed-out calls' }],
  };
}

/**
 * The select: this page, every client, then the Clients and Users groups.
 * A scope whose option is gone (a client that disconnected) keeps the
 * option it was chosen from, so the select still names what it shows.
 */
export function scopeSelectHtml(attribute: string, scope: ChipScope, options: ScopeOptions, chosen: ScopeOption | null, escape: (value: string) => string): string {
  const selected = scopeValue(scope);
  const listed = [...options.clients, ...options.users].some((option) => option.value === selected);
  const kept = !listed && chosen !== null && chosen.value === selected ? [chosen] : [];
  const option = (entry: ScopeOption) => `<option value="${escape(entry.value)}"${entry.value === selected ? ' selected' : ''}>${escape(entry.label)}</option>`;
  const isUserScope = scope.kind === 'user';
  const clients = isUserScope ? options.clients : [...options.clients, ...kept];
  const users = isUserScope ? [...options.users, ...kept] : options.users;
  const fixed = [{ value: 'page', label: 'From this page' }, { value: 'all', label: 'From every client' }].map(option).join('');
  return `<select ${attribute} aria-label="Requests from">${fixed}<optgroup label="Clients">${clients.map(option).join('')}</optgroup><optgroup label="Users">${users.map(option).join('')}</optgroup></select>`;
}

/**
 * The source a row reads on a live host: this page, the listed client that
 * sent it, by kind and label, Studio and agents for a call no client sent,
 * and otherwise the source's own label.
 */
export function liveSourceLabel(fields: ChipScopeFields, source: CallerSource, clients: readonly LiveClient[], selfClientId: string): string {
  if (source === 'page') return CALLER_SOURCE_LABELS.page;
  if (isAgentCall(fields)) return AGENTS_LABEL;
  const caller = fields.caller;
  const listed = otherClients(clients, selfClientId).find((client) => caller?.clientId === client.clientId && caller.kind === CALLER_KINDS[client.kind]);
  return listed === undefined ? CALLER_SOURCE_LABELS[source] : withLabel(CLIENT_KIND_LABELS[listed.kind], listed.label);
}
