/**
 * Tools a connected tab of the app answers. A tab announces the tool names
 * it handles when it registers; the bridge sends it a `tool-call` frame for
 * one of them and resolves the call with the tab's `tool-result`.
 *
 * A live host uses this for service reads (`serve/hosted/live-reads.ts`):
 * the tab runs the read on the app's own Firebase instances, so pyric needs
 * no production credential. The newest tab that handles a name answers it.
 */
import { randomUUID } from 'node:crypto';
import type { ToolResult } from 'pyric/sandbox/internal';
import type { BridgeMessage, ToolCallResponse } from '../protocol.js';
import { hasValidToolReply } from './reply-envelope.js';

export type SendToTab = (frame: BridgeMessage) => void;

export interface TabTools {
  /** A tab announces the tools it answers. Returns the disconnect, which fails the tab's calls in flight. */
  register(send: SendToTab, tools: readonly string[]): () => void;
  /** Sends the call to the newest tab that handles `name`; undefined when no connected tab does. */
  call(name: string, args: Record<string, unknown>): Promise<ToolResult> | undefined;
  /** A tab's reply to one of its calls. */
  receive(frame: ToolCallResponse): void;
}

interface Tab {
  send: SendToTab;
  tools: ReadonlySet<string>;
}

interface PendingTabCall {
  tab: Tab;
  resolve: (result: ToolResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const TAB_CLOSED = 'The tab answering this call closed before it replied.';

export function createTabTools(callTimeoutMs: number): TabTools {
  const tabs: Tab[] = [];
  const pending = new Map<string, PendingTabCall>();

  function settle(id: string, result: ToolResult): void {
    const entry = pending.get(id);
    const isUnknownCall = entry === undefined;
    if (isUnknownCall) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.resolve(result);
  }

  function newestTabFor(name: string): Tab | undefined {
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      const tab = tabs[index];
      if (tab.tools.has(name)) return tab;
    }
    return undefined;
  }

  return {
    register(send, tools) {
      const tab: Tab = { send, tools: new Set(tools) };
      tabs.push(tab);
      return () => {
        const index = tabs.indexOf(tab);
        if (index >= 0) tabs.splice(index, 1);
        for (const [id, entry] of pending) {
          if (entry.tab === tab) settle(id, { ok: false, summary: TAB_CLOSED });
        }
      };
    },
    call(name, args) {
      const tab = newestTabFor(name);
      const hasNoTab = tab === undefined;
      if (hasNoTab) return undefined;
      const id = randomUUID();
      return new Promise<ToolResult>((resolve) => {
        const timer = setTimeout(() => {
          settle(id, { ok: false, summary: `tab call timed out after ${callTimeoutMs}ms (tool: ${name})` });
        }, callTimeoutMs);
        pending.set(id, { tab, resolve, timer });
        try {
          tab.send({ type: 'tool-call', id, name, args });
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          settle(id, { ok: false, summary: `failed to send the call to the tab: ${detail}` });
        }
      });
    },
    receive(frame) {
      const isMalformedReply = !hasValidToolReply(frame);
      if (isMalformedReply) {
        settle(frame.id, { ok: false, summary: 'The tab sent a malformed tool reply.' });
        return;
      }
      const result = frame.result;
      const answered = frame.ok && result !== undefined;
      if (answered) {
        settle(frame.id, { ok: result.ok, summary: result.summary, data: result.data });
        return;
      }
      settle(frame.id, { ok: false, summary: frame.error?.message ?? 'unknown tab error' });
    },
  };
}
