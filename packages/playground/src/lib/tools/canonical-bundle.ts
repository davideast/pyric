/**
 * Canonical "what is this tool call" bundle. Same serializer powers
 * the drill-in's copy button AND a future MCP `tools/get_call_context`
 * server tool — see `docs/PROPOSAL-tool-call-metadata.md` section 7 for the
 * inverse-flow story.
 *
 * The shape is deliberately stable: don't add fields without
 * updating the proposal doc. Any consumer (in-app paste, external
 * MCP client, eval harness, future replay tool) should be able to
 * round-trip this JSON without losing meaning.
 */
import type { ChatMessage, ToolCall } from '~/lib/store/chat';

export interface CanonicalToolCallBundle {
  /** Unique within the owning session — provider call id OR our
   *  synthesized fallback. */
  id: string;
  /** Raw tool identifier as emitted by the agent (`writeRules`,
   *  `runOnce`, etc.). Not humanized. */
  name: string;
  /** Parsed args the model passed — JSON values, not the string
   *  form. `null` when the agent omitted args. */
  args: unknown;
  /** Parsed result the handler returned. Absent when the call is
   *  still pending. */
  result?: unknown;
  /** Final ok/fail flag set by the handler. Absent when pending. */
  ok?: boolean;
  /** Provider id (`gemini` / `openrouter` / …) of the model that
   *  emitted this call. */
  provider?: string;
  /** Model id (e.g. `gemini-3.1-pro-preview`) — provider-native
   *  slug, not the humanized label. */
  model?: string;
  /** Owning assistant message id — turn-level provenance. */
  turn_id: string;
  /** 1-based index of this call within the owning turn's tool
   *  calls. Stable across renders. */
  sequence_index: number;
  /** Wall-clock ms when the model emitted the call. */
  emitted_at_ms?: number;
  /** Milliseconds from the user's prompt to the call emission.
   *  Computed only when both timestamps are available. */
  time_into_turn_ms?: number;
  /** Snapshot of the message's `thinking` buffer at emission —
   *  the reasoning that led up to this specific call. Absent for
   *  non-reasoning models. */
  thinking_up_to_here?: string;
  /** Provider-stable opaque pointer to the reasoning span
   *  (Gemini's `thoughtSignature`). Presence signals "reproducible". */
  reasoning_signature?: string;
}

export interface BuildBundleOptions {
  /** Include Gemini's `thoughtSignature` (or equivalent) in the
   *  output. Off by default — signatures are opaque, provider-bound,
   *  and useless for the common "paste this tool call somewhere"
   *  workflow. A future settings panel can flip this on for
   *  reproducibility / replay use cases. */
  includeReasoningSignature?: boolean;
}

/**
 * Build the canonical bundle. Pure function — no I/O, no React.
 * Both the in-app copy button and an MCP `tools/get_call_context`
 * handler emit identical JSON for the same input.
 */
export function buildCanonicalBundle(
  call: ToolCall,
  message: ChatMessage,
  options: BuildBundleOptions = {},
): CanonicalToolCallBundle {
  const args = safeJsonParse(call.argsJson);
  const result = call.resultJson !== undefined ? safeJsonParse(call.resultJson) : undefined;
  const sequenceIndex =
    (message.toolCalls?.findIndex((c) => c.id === call.id) ?? -1) + 1;

  const out: CanonicalToolCallBundle = {
    id: call.id,
    name: call.name,
    args,
    turn_id: message.id,
    sequence_index: sequenceIndex,
  };
  if (result !== undefined) out.result = result;
  if (call.ok !== undefined) out.ok = call.ok;
  if (message.providerLabel) out.provider = message.providerLabel;
  if (message.modelLabel) out.model = message.modelLabel;
  if (call.emittedAt !== undefined) {
    out.emitted_at_ms = call.emittedAt;
    // `createdAt` on the message is the assistant's birth — we use
    // it as the proxy for "when the turn started" since the user
    // prompt's createdAt isn't directly on this call's owning
    // message. (Caller can patch in a more accurate origin if
    // available.) The proposal's spec'd `time_into_turn_ms` is
    // computed by the consumer either way.
    out.time_into_turn_ms = call.emittedAt - message.createdAt;
  }
  if (call.thinkingUpToHere) out.thinking_up_to_here = call.thinkingUpToHere;
  if (options.includeReasoningSignature && call.signature) {
    out.reasoning_signature = call.signature;
  }
  return out;
}

function safeJsonParse(s: string | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Pretty-printed string ready to drop into `navigator.clipboard`. */
export function serializeBundle(bundle: CanonicalToolCallBundle): string {
  return JSON.stringify(bundle, null, 2);
}
