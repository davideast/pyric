/**
 * Claude-delegate strategy — the lane-shaped agent loop for the
 * Claude (local CLI) provider.
 *
 * Why: the lane runs `claude -p`, which is ITSELF an agent — it
 * executes tools internally against the dev server's MCP bridge and
 * returns finished text. Driving it from the playground's ReAct loop
 * nests two agents: the react strategy declares 22 playground tools
 * and expects to dispatch the model's tool calls itself, but the CLI
 * session never emits tool calls over the wire (the lane strips the
 * request-level schemas by design). A real Opus turn (trace
 * t-mq9msa9m-xcgt) showed the failure: the model obeyed the react
 * prompt's tool mandate by writing the call as TEXT, dispatched
 * nothing, and ended the turn.
 *
 * So delegate mode makes exactly ONE LLM call per user turn:
 *
 *   - messages = [system, …history, user] — same composition as the
 *     react loop, so multi-turn transcripts replay identically;
 *   - the session's tool declarations ride along ONLY as the MCP-mode
 *     flag (`tools.length > 0` is what flips the provider + lane into
 *     bridge mode with workspace push/pull around the turn — see
 *     `~/lib/llm/claude.ts`); their schemas are not forwarded;
 *   - text/thinking stream through; turn_complete carries the CLI's
 *     real usage + cost;
 *   - NO playground-side tool dispatch ever happens. A `tool_call`
 *     event from this provider is a contract violation and fails LOUD.
 *
 * The strategy emits a `strategy_routed` custom event (the same
 * milestone the C2 router emits) so the UI's phase stepper shows the
 * turn was delegated rather than silently skipping the react/DV story.
 */
import type {
  AgentStrategy,
  ModelMessage,
  StrategyEvent,
  StrategyRunInput,
  ToolSpec,
} from '@inbrowser/agent';
import { ClaudeTranscriptFilter } from '~/lib/llm/claude-transcript';

/** Providers whose turns are delegated to their own agent loop instead
 *  of the playground strategies. The session host consults this before
 *  strategy selection; the Settings UI disables the strategy picker for
 *  these lanes. */
export function isDelegatedProvider(providerId: string): boolean {
  return providerId === 'claude';
}

/** Same [system, …history, user] composition the react loop uses, so a
 *  session that switches providers mid-conversation replays the same
 *  transcript. Tool calls recorded on other lanes are flattened by the
 *  lane's transcript renderer downstream. */
function buildMessages(input: StrategyRunInput): ModelMessage[] {
  const out: ModelMessage[] = [{ role: 'system', text: input.systemPrompt }];
  for (const m of input.history) {
    if (m.role === 'system') continue; // already emitted
    if (m.role === 'assistant') {
      const toolCalls =
        m.toolCalls?.map((c) => ({
          id: c.id,
          name: c.name,
          args: safeParse(c.argsJson),
          ...(c.signature ? { signature: c.signature } : {}),
        })) ?? [];
      out.push({
        role: 'assistant',
        text: m.text,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      for (const c of m.toolCalls ?? []) {
        if (c.resultJson !== undefined) {
          out.push({ role: 'tool', toolCallId: c.id, name: c.name, resultJson: c.resultJson, text: '' });
        }
      }
      continue;
    }
    out.push({ role: m.role, text: m.text });
  }
  out.push({ role: 'user', text: input.prompt });
  return out;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function createClaudeDelegateStrategy(): AgentStrategy {
  return {
    id: 'claude-delegate',
    async *run(input, signal): AsyncIterable<StrategyEvent> {
      yield {
        kind: 'custom',
        name: 'strategy_routed',
        data: {
          strategy: 'claude-delegate',
          source: 'provider',
          reason:
            'Claude (local CLI) runs its own agent — tools execute inside `claude -p` via the MCP bridge; the playground strategy picker does not apply.',
        },
      };

      if (signal.aborted) {
        yield { kind: 'error', message: 'aborted' };
        return;
      }

      const messages = buildMessages(input);
      // Declarations are the MCP-mode flag only — the lane cannot
      // register caller schemas in `claude -p` and documents that it
      // drops them. An empty toolList (provider without the bridge)
      // degrades to a plain text turn, also correct.
      const toolDecls = input.toolList.map((h) => ({
        name: h.name,
        description: h.description,
        parameters: h.parameters,
      }));

      const turnIdForReq = input.turnId ?? 'turn-anon';
      const requestId = `${turnIdForReq}#0`;
      input.tracer?.emit({
        kind: 'llm_request',
        data: {
          requestId,
          turnId: turnIdForReq,
          iteration: 0,
          ts: Date.now(),
          systemPrompt: input.systemPrompt,
          messages: messages.map((m) => ({ ...m })),
          tools: toolDecls.map((t) => ({ ...t })),
          llm: { id: input.llm.id, supportsTools: input.llm.supportsTools },
        },
      });

      let text = '';
      let thinking = '';
      let usage: Extract<StrategyEvent, { kind: 'turn_complete' }> | null = null;
      const transcript = new ClaudeTranscriptFilter();

      const emitFiltered = function* (chunk: string): Generator<StrategyEvent> {
        const { cleanText, activities, activityUpdates } = transcript.push(chunk);
        if (cleanText) yield { kind: 'text', chunk: cleanText };
        for (const activity of activities) {
          yield { kind: 'custom', name: 'delegated_activity', data: activity };
        }
        for (const update of activityUpdates) {
          yield { kind: 'custom', name: 'delegated_activity_update', data: update };
        }
      };

      const toolSpecs: ToolSpec[] = toolDecls.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));

      for await (const ev of input.llm.chat(
        {
          messages,
          tools: toolSpecs,
          toolUseEnabled: toolSpecs.length > 0 && input.llm.supportsTools,
        },
        signal,
      )) {
        if (ev.kind === 'text') {
          text += ev.text;
          yield* emitFiltered(ev.text);
        } else if (ev.kind === 'thinking') {
          thinking += ev.text;
          yield { kind: 'thinking', chunk: ev.text };
        } else if (ev.kind === 'usage') {
          // ModelEvent ends the turn with a `usage` event (there is no
          // `turn_complete` on the stream). Synthesize the StrategyEvent
          // turn_complete: the ModelUsage passes through directly, and the
          // details come from the served lane (the stream carries no
          // details — `input.llm.id` is the requested model).
          usage = { kind: 'turn_complete', usage: ev.usage, details: { requestedModel: input.llm.id } };
        } else if (ev.kind === 'error') {
          yield { kind: 'error', message: ev.message };
          return;
        } else if (ev.kind === 'tool_call') {
          // Contract violation — the delegated lane runs its tool loop
          // INSIDE claude -p and never streams tool calls back. Fail
          // loud rather than dispatch a call this strategy promised
          // never to make.
          yield {
            kind: 'error',
            message:
              `claude-delegate: provider emitted an unexpected tool_call ('${ev.name}'). ` +
              'The Claude lane executes tools inside `claude -p`; the playground must not dispatch. ' +
              'This is a lane/provider contract drift — file it.',
          };
          return;
        }
      }

      const tail = transcript.flush();
      if (tail.cleanText) yield { kind: 'text', chunk: tail.cleanText };
      for (const activity of tail.activities) {
        yield { kind: 'custom', name: 'delegated_activity', data: activity };
      }
      for (const update of tail.activityUpdates) {
        yield { kind: 'custom', name: 'delegated_activity_update', data: update };
      }
      yield { kind: 'custom', name: 'delegated_transcript', data: { raw: transcript.raw } };

      input.tracer?.emit({
        kind: 'llm_response',
        data: {
          requestId,
          ts: Date.now(),
          text,
          thinking,
          toolCalls: [],
          ...(usage
            ? {
                usage: {
                  promptTokens: usage.usage.promptTokens,
                  outputTokens: usage.usage.outputTokens,
                  ...(usage.usage.cachedTokens !== undefined
                    ? { cachedTokens: usage.usage.cachedTokens }
                    : {}),
                },
              }
            : {}),
        },
      });

      if (usage) yield usage;
    },
  };
}
