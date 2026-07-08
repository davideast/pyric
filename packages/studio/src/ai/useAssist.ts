/**
 * The single-shot assist harness. Each Studio AI assist ("fix this rule",
 * "generate this data", "explain this") is one short agent run: build an
 * ephemeral `@inbrowser/agent` session, submit one prompt, and fold the
 * `SessionEvent` stream into a small `{ status, text, steps, error }` state the
 * assist UI renders. This is the narrow turn handler the playground's full
 * multi-turn `useAgentLoop` does not give us.
 *
 * The fold is a pure reducer (unit-tested with scripted events); the session
 * assembly is exercised end-to-end with a fake `LlmClient` (no key needed). The
 * live client + tools are injected by the hook from `useLlmClient` + the assist.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAgentSession,
  createReactLoopStrategy,
  createToolRegistry,
  createDispatch,
  createMetricsCollector,
  type AgentSession,
  type SessionEvent,
  type ToolHandler,
  type ToolContext,
  type ModelClient,
} from '@inbrowser/agent';
import { useLlmClient } from './inference.js';

export type AssistStatus = 'idle' | 'running' | 'done' | 'error';

/** One tool the assist invoked, for a step display. */
export interface AssistStep {
  callId: string;
  name: string;
  args: unknown;
  status: 'running' | 'ok' | 'error';
  summary?: string;
}

export interface AssistState {
  status: AssistStatus;
  /** Accumulated assistant text. */
  text: string;
  /** Accumulated hidden reasoning (surface only if the assist opts in). */
  thinking: string;
  steps: AssistStep[];
  error: string | null;
}

export const INITIAL_ASSIST_STATE: AssistState = {
  status: 'idle',
  text: '',
  thinking: '',
  steps: [],
  error: null,
};

/** Pure reducer: fold one `SessionEvent` into the assist state. */
export function foldAssistEvent(state: AssistState, ev: SessionEvent): AssistState {
  switch (ev.kind) {
    case 'turn_started':
      return { ...state, status: 'running' };
    case 'text':
      return { ...state, text: state.text + ev.chunk };
    case 'thinking':
      return { ...state, thinking: state.thinking + ev.chunk };
    case 'tool_started':
      return {
        ...state,
        steps: [...state.steps, { callId: ev.callId, name: ev.name, args: ev.args, status: 'running' }],
      };
    case 'tool_finished':
      return {
        ...state,
        steps: state.steps.map((s) =>
          s.callId === ev.callId
            ? { ...s, status: ev.result.ok ? 'ok' : 'error', summary: ev.result.summary }
            : s,
        ),
      };
    case 'error':
      return { ...state, status: 'error', error: ev.message };
    case 'completed':
      // An error already terminated the run; otherwise this is success.
      return { ...state, status: state.status === 'error' ? 'error' : 'done' };
    default:
      // workspace_changed / runtime_changed / turn_completed / strategy_event:
      // not surfaced by the assist UI.
      return state;
  }
}

export interface AssistConfig {
  llm: ModelClient;
  /** Tools available this run (empty = plain chat). */
  tools?: ToolHandler[];
  /** Extra `ToolContext` the tools need (sandbox handle, lint). `signal` is
   *  supplied by the harness. */
  toolContext?: Omit<Partial<ToolContext>, 'signal'>;
  systemPrompt: string;
}

/** Assemble an ephemeral one-shot agent session (default ReAct strategy). */
export function createAssistSession(cfg: AssistConfig, signal: AbortSignal): AgentSession {
  const tools = cfg.tools ?? [];
  const registry = createToolRegistry();
  for (const t of tools) registry.register(t);
  return createAgentSession({
    strategy: createReactLoopStrategy(),
    llm: cfg.llm,
    tools: createDispatch(registry),
    toolList: tools,
    toolContext: (): ToolContext => ({ ...cfg.toolContext, signal }),
    systemPromptBuilder: () => cfg.systemPrompt,
    metrics: createMetricsCollector(),
    history: [],
  });
}

export interface AssistRun {
  /** Resolves with the final state when the run finishes. */
  done: Promise<AssistState>;
  cancel(): void;
}

/** Drive one assist run to completion, streaming states to `onState`. */
export function runAssist(
  cfg: AssistConfig,
  prompt: string,
  onState: (s: AssistState) => void,
): AssistRun {
  const ctrl = new AbortController();
  const session = createAssistSession(cfg, ctrl.signal);
  const done = (async (): Promise<AssistState> => {
    let state: AssistState = { ...INITIAL_ASSIST_STATE, status: 'running' };
    onState(state);
    try {
      for await (const ev of session.submit(prompt, ctrl.signal)) {
        state = foldAssistEvent(state, ev);
        onState(state);
      }
    } catch (e) {
      state = { ...state, status: 'error', error: e instanceof Error ? e.message : String(e) };
      onState(state);
    }
    return state;
  })();
  return {
    done,
    cancel() {
      ctrl.abort();
      session.cancel();
    },
  };
}

export interface UseAssistOptions {
  tools?: ToolHandler[];
  toolContext?: Omit<Partial<ToolContext>, 'signal'>;
  systemPrompt: string;
}

export interface UseAssistResult {
  state: AssistState;
  /** Start a run (cancels any in-flight one). */
  run: (prompt: string) => void;
  cancel: () => void;
  /** True when the active provider has no API key (run reports an error state). */
  missingKey: boolean;
  /** Present when the selected provider cannot run in this build. */
  disabledReason: string | null;
}

/** React hook: one assist, wired to the active `LlmClient`. */
export function useAssist(opts: UseAssistOptions): UseAssistResult {
  const { client, missingKey, disabledReason } = useLlmClient();
  const [state, setState] = useState<AssistState>(INITIAL_ASSIST_STATE);
  const runRef = useRef<AssistRun | null>(null);

  const run = useCallback(
    (prompt: string) => {
      runRef.current?.cancel();
      if (!client) {
        setState({
          ...INITIAL_ASSIST_STATE,
          status: 'error',
          error: disabledReason ?? 'No API key set. Add one in Settings to use AI assists.',
        });
        return;
      }
      runRef.current = runAssist(
        {
          llm: client,
          ...(opts.tools ? { tools: opts.tools } : {}),
          ...(opts.toolContext ? { toolContext: opts.toolContext } : {}),
          systemPrompt: opts.systemPrompt,
        },
        prompt,
        setState,
      );
    },
    [client, disabledReason, opts.tools, opts.toolContext, opts.systemPrompt],
  );

  const cancel = useCallback(() => runRef.current?.cancel(), []);

  useEffect(() => () => runRef.current?.cancel(), []);

  return { state, run, cancel, missingKey, disabledReason };
}
