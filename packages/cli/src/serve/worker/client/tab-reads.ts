/**
 * A live page's answers to its host's reads. `@pyric/live` puts a reader on
 * the page hub (`Symbol.for('pyric.live.reads')`, `packages/live/src/tab-reads.ts`)
 * once its Firestore or Database row loads; this file announces the reader's
 * tools on the page's own host connection, as a `hello` frame, each time
 * they change, and answers each `tool-call` the host routes to the tab with
 * a `tool-result`. The host keeps them in its tab tools
 * (`bridge/server/tab-tools.ts`). Outside live mode the hub has no reader,
 * so a page announces nothing.
 */
import type { HelloFromClient, ToolCallRequest, ToolCallResponse } from '../../../bridge/protocol.js';

interface TabReadResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly data?: unknown;
}

/** The page hub `@pyric/live` writes. */
interface LiveReadHub {
  reader?: {
    tools(): string[];
    call(name: string, args: Record<string, unknown>): Promise<TabReadResult> | undefined;
  };
  readonly listeners: Set<() => void>;
}

const READ_HUB_KEY = Symbol.for('pyric.live.reads');

function readHub(): LiveReadHub {
  const scope = globalThis as { [READ_HUB_KEY]?: LiveReadHub };
  return scope[READ_HUB_KEY] ??= { listeners: new Set() };
}

/**
 * Announces the tools this page answers through `send` now, when it answers
 * any, and again each time they change. Returns the stop.
 */
export function announceTabReads(tabId: string, send: (frame: HelloFromClient) => void): () => void {
  const hub = readHub();
  let announced = '[]';
  const announce = (): void => {
    const tools = hub.reader?.tools() ?? [];
    const listed = JSON.stringify(tools);
    const isUnchanged = listed === announced;
    if (isUnchanged) return;
    announced = listed;
    try {
      send({ type: 'hello', protocol: 1, tools, sandboxId: tabId });
    } catch {
      // A socket that closed meanwhile announces again on its next attach.
    }
  };
  announce();
  hub.listeners.add(announce);
  return () => hub.listeners.delete(announce);
}

/** Answers one call the host routed to this tab. */
export async function answerTabCall(frame: ToolCallRequest, send: (frame: ToolCallResponse) => void): Promise<void> {
  let reply: ToolCallResponse;
  try {
    const answer = readHub().reader?.call(frame.name, frame.args);
    const result = answer === undefined
      ? { ok: false, summary: `This tab does not answer ${frame.name}.` }
      : await answer;
    reply = { type: 'tool-result', id: frame.id, ok: true, result: { ok: result.ok, summary: result.summary, data: result.data } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reply = { type: 'tool-result', id: frame.id, ok: false, error: { code: 'tab-error', message } };
  }
  try {
    send(reply);
  } catch {
    // The host fails a call whose tab closed before it replied.
  }
}
