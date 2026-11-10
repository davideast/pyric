/**
 * Whose calls a live host's traffic view lists: the rule the runtime chip's
 * "From" select and Studio's share, so both keep the same rows for the same
 * choice.
 *
 * - This page: the viewing page's own calls, as the sandbox's page scope.
 *   Only a view that is a page offers it.
 * - Every client: everything the host received.
 * - One client the host lists (`live.clients`): its calls, by kind and client
 *   id (`eventScope`).
 * - Studio and agents: calls with no client id, which no client listed
 *   sent: Studio, MCP and server admin code the bridge relays.
 * - One user: calls that ran as a uid (`eventScope`), and signed-out calls.
 *
 * A user option is named by the email a client's page reported for that
 * uid, else by the uid. The value an option carries, and everything the
 * scope filters on, is the uid.
 */
import type { EventCaller } from '../types/operation.js';
import { callerSource, eventScope, type CallerSource, type ScopeClient, type ScopedEventFields } from './caller-source.js';
import type { LiveHostStatus } from './live-status.js';

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];

/** Whose calls a view lists or counts. */
export type ClientScope =
  | { kind: 'page' }
  | { kind: 'all' }
  | { kind: 'client'; client: ScopeClient }
  | { kind: 'agents' }
  | { kind: 'user'; user: string | null };

export const PAGE_SCOPE: ClientScope = { kind: 'page' };
export const EVERY_CLIENT_SCOPE: ClientScope = { kind: 'all' };

/** The event caller kind each listed client kind stamps. */
export const LIVE_CLIENT_CALLER_KINDS: Readonly<Record<LiveClient['kind'], EventCaller['kind']>> = {
  browser: 'page',
  'service-worker': 'service-worker',
  node: 'node',
};

/** The order clients list in, as the chip's Live tab lists them. */
const KIND_ORDER: readonly LiveClient['kind'][] = ['browser', 'service-worker', 'node'];

/** What the agents option is named, after "From". */
export const AGENTS_SCOPE_LABEL = 'Studio and agents';

/** The value an option carries for `scope`. */
export function scopeValue(scope: ClientScope): string {
  if (scope.kind === 'client') return `client:${scope.client.kind}:${scope.client.clientId}`;
  if (scope.kind === 'user') return scope.user === null ? 'signed-out' : `user:${scope.user}`;
  return scope.kind;
}

/** The scope an option's value names, or null for a value no option carries. */
export function scopeFromValue(value: string): ClientScope | null {
  const fixed: Record<string, ClientScope> = { page: PAGE_SCOPE, all: EVERY_CLIENT_SCOPE, agents: { kind: 'agents' }, 'signed-out': { kind: 'user', user: null } };
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

/** A call no listed client sent: a caller with no client id that is not a page. */
export function isAgentCall(fields: ScopedEventFields): boolean {
  const caller = fields.caller;
  return caller !== undefined && caller.clientId === undefined && caller.kind !== 'page';
}

/**
 * Whether a row or event is in `scope`, as the page whose id is
 * `viewerPageId` reads it. A view that is not a page never offers the page
 * scope, so it passes no id.
 */
export function inClientScope(fields: ScopedEventFields, scope: ClientScope, viewerPageId?: string): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'page') {
    const source = fields.caller === undefined ? undefined : callerSource(fields.caller, viewerPageId);
    return isThisPage(source);
  }
  if (scope.kind === 'agents') return isAgentCall(fields);
  if (scope.kind === 'client') return eventScope(fields, { client: scope.client });
  return eventScope(fields, { user: scope.user });
}

/** The clients the host lists, other than the viewing page's profile, in the Live tab's order. */
export function scopeClients(clients: readonly LiveClient[], selfClientId?: string): LiveClient[] {
  const isSelf = (client: LiveClient) => client.kind === 'browser' && client.clientId === selfClientId;
  const others = clients.filter((client) => !isSelf(client));
  return KIND_ORDER.flatMap((kind) => others.filter((client) => client.kind === kind));
}

/** The email each uid's client reported, the first one listed. */
export function liveClientEmails(clients: readonly LiveClient[]): Map<string, string> {
  const emails = new Map<string, string>();
  for (const client of clients) {
    const named = client.user !== null && client.email !== undefined && client.email !== '' && !emails.has(client.user);
    if (named) emails.set(client.user!, client.email!);
  }
  return emails;
}

/** `kind` and `label` as one name: `Node process server.mjs`. */
export function withClientLabel(kind: string, label: string | undefined): string {
  return label === undefined || label === '' ? kind : `${kind} ${label}`;
}

/** One option of a "From" select. */
export interface ScopeOption {
  readonly value: string;
  readonly label: string;
}

/** What a "From" select lists beside its fixed options. */
export interface ScopeOptions {
  readonly clients: readonly ScopeOption[];
  readonly users: readonly ScopeOption[];
}

/**
 * `options` with the option `selected` was chosen from kept in its group, when
 * that option is gone (a client that disconnected): the select still names
 * what the view lists, and the scope keeps filtering to it until another
 * option is chosen. `chosen` is the option as the view last listed it.
 */
export function keepChosenOption(options: ScopeOptions, selected: string, chosen: ScopeOption | null): ScopeOptions {
  const listed = [...options.clients, ...options.users].some((option) => option.value === selected);
  const keeps = !listed && chosen !== null && chosen.value === selected;
  if (!keeps) return options;
  const isUserScope = scopeFromValue(selected)?.kind === 'user';
  if (isUserScope) return { clients: options.clients, users: [...options.users, chosen] };
  return { clients: [...options.clients, chosen], users: options.users };
}

/** How a view names each client kind in an option, after "From", and which listed client is the view's own. */
export interface ScopeOptionNames {
  readonly kindLabels: Readonly<Record<LiveClient['kind'], string>>;
  readonly selfClientId?: string;
}

/**
 * The select's client and user options: every client the host lists other
 * than the view's own profile, then Studio and agents; every distinct uid the
 * clients and `seenUsers` name, then signed-out calls.
 */
export function clientScopeOptions(clients: readonly LiveClient[], names: ScopeOptionNames, seenUsers: Iterable<string>): ScopeOptions {
  const clientOptions = scopeClients(clients, names.selfClientId).map((client) => {
    const scope: ClientScope = { kind: 'client', client: { kind: LIVE_CLIENT_CALLER_KINDS[client.kind], clientId: client.clientId } };
    return { value: scopeValue(scope), label: `From ${withClientLabel(names.kindLabels[client.kind], client.label)}` };
  });
  const emails = liveClientEmails(clients);
  const uids = new Set<string>();
  for (const client of clients) if (client.user !== null) uids.add(client.user);
  for (const uid of seenUsers) uids.add(uid);
  const users = [...uids].map((uid) => ({ value: scopeValue({ kind: 'user', user: uid }), label: `From ${emails.get(uid) ?? uid}` }));
  return {
    clients: [...clientOptions, { value: 'agents', label: `From ${AGENTS_SCOPE_LABEL}` }],
    users: [...users, { value: 'signed-out', label: 'From signed-out calls' }],
  };
}
