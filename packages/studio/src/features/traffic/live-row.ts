/**
 * What a Traffic row reads on a live host, where every row lays on one grid
 * and opens in place: the method as the row shows it, the outcome pill, the
 * expansion's source, identity and outcome, and the "From" select's options
 * and rule. The select's rule is the one the runtime chip scopes by
 * (`client-scope` in `pyric/sandbox/internal`); Studio is not a page, so it
 * offers no "this page" and names a browser profile a browser tab.
 */
import type { SandboxEvent } from 'pyric/sandbox';
import {
  callerSource,
  callerSourceLabelOutsidePage,
  clientScopeOptions,
  inClientScope,
  LIVE_CLIENT_CALLER_KINDS,
  liveClientEmails,
  productionVerdict,
  scopeClients,
  scopeFromValue,
  withClientLabel,
  type LiveHostStatus,
  type ScopeOptions,
  type ScopedEventFields,
} from 'pyric/sandbox/internal';
import { verdictFor, verdictLabel, type StudioTrafficEvent } from './verdict.js';

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];

/** An Admin SDK method's `<Class>.` prefix: client prefixes (`onDisconnect.`) are lowercase and stay. */
const ADMIN_CLASS_PREFIX = /^[A-Z][A-Za-z]*\./;

/** The method as a live row shows it: an Admin SDK name without its class. The full name stays on the event. */
export function methodLabel(method: string): string {
  return method.replace(ADMIN_CLASS_PREFIX, '');
}

/** The outcome pill: its text and the verdict its color reads. */
export interface RowOutcome {
  readonly label: string;
  readonly verdict: 'allow' | 'deny' | 'bypassed' | 'proof-unsupported';
}

/** A live row's outcome pill: production's ok, denied or failed, else the sandbox's Rules verdict, else none. */
export function rowOutcome(event: StudioTrafficEvent): RowOutcome | null {
  const production = event.production;
  if (production !== undefined) {
    const verdict = productionVerdict(production.outcome);
    return { label: verdict, verdict: verdict === 'ok' ? 'allow' : 'deny' };
  }
  const verdict = verdictFor(event);
  return verdict === null ? null : { label: verdictLabel(verdict), verdict };
}

/** The expansion's Outcome line: production's answer with its error code, or the sandbox's Rules verdict. */
export function outcomeText(event: StudioTrafficEvent): string {
  const production = event.production;
  if (production === undefined) {
    const verdict = verdictFor(event);
    return verdict === null ? 'Sandbox: served' : `Sandbox rules: ${verdictLabel(verdict)}`;
  }
  const outcome = production.outcome;
  if (outcome.status === 'ok') return 'ok';
  const word = productionVerdict(outcome);
  const message = (outcome as { message?: string }).message;
  return message ? `${word}, ${outcome.code}: ${message}` : `${word}, ${outcome.code}`;
}

/** The expansion's Time line: the date, and the time to the millisecond. */
export function fullTime(at: number): string {
  const date = new Date(at);
  const millis = String(date.getMilliseconds()).padStart(3, '0');
  return `${date.toLocaleDateString('en-CA')} ${date.toLocaleTimeString('en-GB', { hour12: false })}.${millis}`;
}

/** Each client kind as the expansion's Source names it. */
const SOURCE_KIND_LABELS: Readonly<Record<LiveClient['kind'], string>> = {
  browser: 'Browser tab',
  'service-worker': 'Service worker',
  node: 'Node process',
};

/** Each client kind as a "From" option names it, after "From". */
const OPTION_KIND_LABELS: Readonly<Record<LiveClient['kind'], string>> = {
  browser: 'browser tab',
  'service-worker': 'service worker',
  node: 'Node process',
};

function listedClient(event: StudioTrafficEvent, clients: readonly LiveClient[]): LiveClient | undefined {
  const caller = event.caller;
  if (caller?.clientId === undefined) return undefined;
  return scopeClients(clients).find((client) => client.clientId === caller.clientId && LIVE_CLIENT_CALLER_KINDS[client.kind] === caller.kind);
}

function isAdminSdkCall(event: StudioTrafficEvent): boolean {
  return event.operationContext.authLens.mode === 'admin';
}

/** The expansion's Source: the listed client that sent the op, by kind and label, else Studio's name for its source. */
export function liveSourceLabel(event: StudioTrafficEvent, clients: readonly LiveClient[]): string {
  const source = callerSource(event.caller);
  const client = listedClient(event, clients);
  if (client === undefined) return callerSourceLabelOutsidePage(source);
  const isAdminProcess = client.kind === 'node' && isAdminSdkCall(event);
  const kind = isAdminProcess ? 'Node process, Admin SDK' : SOURCE_KIND_LABELS[client.kind];
  return withClientLabel(kind, client.label);
}

/** The expansion's Identity: the email a client reported for the op's uid, else the uid, else signed out. */
export function liveIdentity(event: StudioTrafficEvent, clients: readonly LiveClient[]): string {
  const uid = event.auth?.uid;
  if (uid === undefined) return 'signed out';
  return liveClientEmails(clients).get(uid) ?? uid;
}

/** The value of the "From" select's first option. */
export const EVERY_CLIENT = 'all';

/** The "From" select's client and user options: every client the host lists, then each uid the clients and rows name. */
export function fromOptions(clients: readonly LiveClient[], events: readonly StudioTrafficEvent[]): ScopeOptions {
  const seen = events.flatMap((event) => (event.auth ? [event.auth.uid] : []));
  return clientScopeOptions(clients, { kindLabels: OPTION_KIND_LABELS }, seen);
}

/** The events in the "From" scope `value` names; an unknown value keeps every event. */
export function inFromScope<E extends Pick<StudioTrafficEvent, 'caller' | 'auth'>>(events: readonly E[], value: string): E[] {
  const scope = scopeFromValue(value);
  const keepsAll = scope === null || scope.kind === 'all' || scope.kind === 'page';
  if (keepsAll) return [...events];
  return events.filter((event) => inClientScope(event, scope));
}

function attachListenerId(event: SandboxEvent): string | undefined {
  if (event.kind === 'listener_attach') return event.listenerId;
  if (event.kind === 'listener' && event.phase === 'attach') return event.listenerId;
  return undefined;
}

function detachListenerId(event: SandboxEvent): string | undefined {
  if (event.kind === 'listener_detach' || event.kind === 'listener_errored') return event.listenerId;
  if (event.kind === 'listener' && (event.phase === 'detach' || event.phase === 'errored')) {
    return event.listenerId;
  }
  return undefined;
}

function scopedFieldsOf(event: SandboxEvent): ScopedEventFields {
  const rawAuth = (event as { auth?: { uid?: unknown } | null }).auth;
  let auth: ScopedEventFields['auth'];
  if (rawAuth === null) {
    auth = null;
  } else if (typeof rawAuth?.uid === 'string') {
    auth = { uid: rawAuth.uid };
  }
  if (event.caller !== undefined && auth !== undefined) {
    return { caller: event.caller, auth };
  }
  if (event.caller !== undefined) {
    return { caller: event.caller };
  }
  if (auth !== undefined) {
    return { auth };
  }
  return {};
}

/**
 * Raw sandbox events in the "From" scope `value` names, preserving lifecycle
 * detach/error events for any listener attached within the scope so sign-out
 * before detach never leaves a zombie active listener.
 */
export function inRawEventFromScope(events: readonly SandboxEvent[], value: string): SandboxEvent[] {
  const scope = scopeFromValue(value);
  const keepsAll = scope === null || scope.kind === 'all' || scope.kind === 'page';
  if (keepsAll) return [...events];
  const seenListeners = new Set<string>();
  const filtered: SandboxEvent[] = [];
  for (const event of events) {
    if (inClientScope(scopedFieldsOf(event), scope)) {
      const attached = attachListenerId(event);
      if (attached !== undefined) seenListeners.add(attached);
      filtered.push(event);
      continue;
    }
    const detached = detachListenerId(event);
    if (detached !== undefined && seenListeners.has(detached)) {
      filtered.push(event);
    }
  }
  return filtered;
}
