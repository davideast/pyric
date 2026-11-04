/**
 * Which connection sent a frame, stamped onto the events its operation emits.
 *
 * Both hosts call `handleMessage` for every frame: the SharedWorker for each
 * page port and each bridge relay, and the Node host for each admitted socket.
 * `handleMessage` reads the caller here, from the port and the frame's relay
 * marks, and binds it to the frame before dispatch. `opProvenance` then
 * carries it into the synchronous provenance window and into the
 * operation-scoped Storage handles, so it reaches events emitted after an
 * await as well.
 *
 * A page is named by the tab id it declared in its `appConfig`, or else by
 * its activity journey id, the per-port id the activity monitor already keys
 * pages by. The host hands each page that id on its event subscription.
 */
import type { EventCaller } from 'pyric/sandbox';
import type { InboundMessage } from '../protocol.js';
import { activityJourneyId, type HostCtx, type PortLike } from '../host-context.js';

/**
 * What a host admitted a port as. Unmarked ports are pages: every port the
 * SharedWorker accepts directly is a tab. `node` is a Node host socket from a
 * server process using the client SDK; `relay` is a bridge relay's session.
 */
export type PortConnection = 'page' | 'node' | 'relay';

const CALLER = Symbol('pyric.host.caller');

type CallerBound = { [CALLER]?: EventCaller };

/** Record what `port` carries, when it is not a page. */
export function markPortConnection(ctx: HostCtx, port: PortLike, connection: PortConnection): void {
  (ctx.portConnections ??= new WeakMap()).set(port, connection);
}

function isPagePort(ctx: HostCtx, port: PortLike): boolean {
  const connection = ctx.portConnections?.get(port);
  return connection === undefined || connection === 'page';
}

/** The longest tab id a page may declare; a longer one is not kept. */
const MAX_TAB_ID_LENGTH = 64;

/** Record the tab id a page declared in its `appConfig`. */
export function setPortTabId(ctx: HostCtx, port: PortLike, tabId: string): void {
  const isUsable = tabId !== '' && tabId.length <= MAX_TAB_ID_LENGTH;
  if (isUsable) (ctx.portTabIds ??= new WeakMap()).set(port, tabId);
}

/**
 * The id this host gives the page on `port`: the tab id the page declared,
 * so every port of a tab and every reload of it share one, or else the
 * port's own activity journey id. Undefined when the port is not a page.
 */
export function pageIdFor(ctx: HostCtx, port: PortLike): string | undefined {
  if (!isPagePort(ctx, port)) return undefined;
  return ctx.portTabIds?.get(port) ?? activityJourneyId(ctx, port);
}

/**
 * The caller of one inbound frame. A relayed frame is server admin code unless
 * it names a lens other than admin; a tool frame is an MCP call; a frame
 * Studio declared is Studio's.
 */
export function callerFor(ctx: HostCtx, port: PortLike, msg: InboundMessage): EventCaller {
  const marks = msg as { issuer?: 'studio'; relaySource?: 'remote'; clientSessionId?: string; actAs?: { mode: string } };
  if (marks.issuer === 'studio') return { kind: 'studio' };
  if (msg.t === 'tool') return { kind: 'mcp' };
  const isRelayed = marks.relaySource === 'remote' || Boolean(marks.clientSessionId);
  if (isRelayed) {
    const namesClientLens = marks.actAs !== undefined && marks.actAs.mode !== 'admin';
    return namesClientLens ? { kind: 'node' } : { kind: 'admin' };
  }
  const pageId = pageIdFor(ctx, port);
  if (pageId === undefined) return { kind: 'node' };
  return { kind: 'page', pageId };
}

/**
 * Bind `caller` to `msg`, the host's own copy of the frame. A frame cannot
 * carry its own: the key is a symbol, which no wire format keeps, and a copy
 * of the frame keeps it.
 */
export function bindCaller(msg: InboundMessage, caller: EventCaller): void {
  (msg as CallerBound)[CALLER] = caller;
}

/** The caller `handleMessage` bound to `msg`, if any. */
export function callerOf(msg: InboundMessage): EventCaller | undefined {
  return (msg as CallerBound)[CALLER];
}
