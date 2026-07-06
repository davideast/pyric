/**
 * "Analyze & Explain" — focused single-shot LLM call that explains
 * one tool call in the context of the user's current workspace.
 *
 * The prompt builder lives here as a pure function so it's reusable
 * across:
 *   - the drill-in's inline Explain action (this file's `runExplain`)
 *   - a future MCP server tool that exposes the same analysis to
 *     external agents (the "inverted flow" — instead of the
 *     playground asking its own LLM, an outside agent like Claude
 *     Desktop queries the playground via MCP for context-rich
 *     analysis of a specific tool call).
 *
 * The pure-function shape (`buildExplainPrompt(call, ctx)` → string)
 * is what an MCP `tools/explain_call` handler would call to produce
 * the prompt before delegating to whatever LLM the MCP client
 * chooses. Don't add I/O to the builder.
 */
import type { ToolCall } from '~/lib/store/chat';
import type { ProviderChatMessage, ProviderTurnResult } from '@inbrowser/agent';
import { PROVIDERS } from './registry';
import { useLlmStore } from '~/lib/store/llm';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { useRuntimeStore, type DenialBlurb } from '~/lib/store/runtime';
import { estimateGeminiCostUsd } from './pricing';

/**
 * Asked at the end of both Explain prompts. The model emits a final
 * fenced block whose body is a JSON object with a `suggestions`
 * array. Each entry is one concrete follow-up prompt the user could
 * send to the agent.
 *
 * Empty array = nothing actionable. Otherwise N cards render, one
 * per suggestion, each with its own Send-to-agent button.
 *
 * Critically, the instruction tells the model to be *aggressive*:
 * if the prose contains phrases like "you could", "consider",
 * "patch", "improve", "try", those are suggestions and need to
 * surface in the structured block. Earlier prompt was too
 * conservative ("actionable: false" emitted even when the prose was
 * full of follow-up ideas).
 *
 * The fence tag `pyric-suggestion` is deliberately invented — no
 * markdown renderer styles it, so the block never confuses the
 * primary CodeBlock chrome. We strip the block from the display
 * text before rendering and surface the parsed JSON via the
 * `SuggestedPromptCard` UI.
 */
export const SUGGESTION_INSTRUCTION = [
  '',
  '── FIREBASE CONVENTIONS (when generating suggestions) ──',
  '- Use `FieldValue.serverTimestamp()` for created/updated fields,',
  '  NEVER `Timestamp.now()` — server stamps avoid client clock',
  '  drift and play correctly under security rules.',
  '- For read-modify-write or multi-document atomic updates suggest',
  '  `runTransaction` or `writeBatch`, not separate reads + writes.',
  '- Don\'t suggest tightening rules around fields the app code',
  '  never writes — speculative hardening creates real drift.',
  '- When the denial is the rule working as designed and there is',
  '  nothing concrete for the agent to change, emit a `no-action`',
  '  suggestion instead of an actionable prompt — sending a',
  '  "keep the rules as they are" prompt to an agent burns tokens',
  '  for nothing.',
  '── END FIREBASE CONVENTIONS ──',
  '',
  '── FOLLOW-UP SUGGESTIONS ──',
  'After your analysis, append EXACTLY ONE fenced code block whose',
  'opening fence is the literal string ```` ```pyric-suggestion ````',
  '(not just `pyric` and not any other variant) containing JSON with',
  'the shape:',
  '',
  '```pyric-suggestion',
  '{',
  '  "suggestions": [',
  '    {',
  '      "kind": "action" | "no-action",',
  '      "label": "...",',
  '      "confidence": 0.0-1.0,',
  '      "rationale": "...",',
  '      "prompt": "..."  // required when kind="action"',
  '    }',
  '  ]',
  '}',
  '```',
  '',
  'Be aggressive about extracting suggestions. ANY phrase in your',
  'prose like "you could", "consider", "I recommend", "you should",',
  '"try", "patch", "improve" counts as a suggestion and MUST surface',
  'as an entry in the array. Emit one entry per distinct idea.',
  '',
  'Per entry:',
  '- `kind`: "action" when the user should send a prompt to the',
  '  agent to make a change. "no-action" when the right move is to',
  '  accept the current behavior (rule doing its job, denial is the',
  '  intent, etc.) — UI renders a disabled "No Action" chip rather',
  '  than a Send button.',
  '- `label`: short imperative phrase, ≤40 chars (e.g. "Patch',
  '  error handler", "Tighten rule on /menu", "Accept rule behavior").',
  '- `confidence` (0.0-1.0): how sure you are this is the right',
  '  next step.',
  '- `rationale`: 1-3 sentences explaining WHY. Render verbatim in',
  '  the drill-in. Plain prose, no markdown headings, name files',
  '  and clauses concretely.',
  '- `prompt`: REQUIRED when kind="action". Exact text to send to',
  '  the agent, imperative voice, ≤200 words. OMIT when',
  '  kind="no-action".',
  '',
  'Always emit at least one entry — either an action OR a no-action',
  'capturing "the right move here is to do nothing, and here is',
  'why."',
  '── END FOLLOW-UP SUGGESTIONS ──',
].join('\n');

export type SuggestionKind = 'action' | 'no-action';

export interface SuggestedPrompt {
  kind: SuggestionKind;
  label: string;
  confidence: number;
  rationale: string;
  /** Required when `kind === 'action'`. Omitted for `no-action`. */
  prompt?: string;
}

/**
 * Parse the trailing `pyric-suggestion` fenced block out of the
 * Explain response. Returns the parsed suggestions array + the text
 * with the block stripped so the UI can render prose cleanly.
 *
 * Graceful failure: missing block / malformed JSON / non-array
 * `suggestions` all collapse to `[]` and the original text is
 * returned unmodified. The model occasionally forgets the trailing
 * block — that's fine, the suggestion cards just don't render.
 *
 * Per-entry validation: drops entries missing `prompt`, clamps
 * `confidence` to [0, 1], synthesizes a `label` from the prompt
 * head when the model omits it.
 */
export function extractSuggestions(text: string): {
  suggestions: SuggestedPrompt[];
  displayText: string;
} {
  // Find the *last* fenced block tagged with a `pyric` variant
  // (`pyric-suggestion`, `pyric`, `pyric-json`, etc.) — the model
  // occasionally rounds the tag to `pyric` and we don't want a
  // missed parse to leak the JSON spec into the visible prose.
  const re = /```pyric[a-z_-]*\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null = null;
  let last: RegExpExecArray | null = null;
  while ((match = re.exec(text)) !== null) last = match;
  if (!last) return { suggestions: [], displayText: text };

  let parsed: unknown;
  try {
    parsed = JSON.parse(last[1]!.trim());
  } catch {
    return { suggestions: [], displayText: text };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { suggestions: [], displayText: text };
  }
  const obj = parsed as Record<string, unknown>;
  const rawList = Array.isArray(obj.suggestions) ? obj.suggestions : [];

  const suggestions: SuggestedPrompt[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const kindRaw = typeof entry.kind === 'string' ? entry.kind : 'action';
    const kind: SuggestionKind = kindRaw === 'no-action' ? 'no-action' : 'action';
    const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
    // Actionable suggestions without a prompt are unusable — drop.
    // `no-action` entries are valid without a prompt.
    if (kind === 'action' && !prompt) continue;
    const rationaleRaw = typeof entry.rationale === 'string' ? entry.rationale.trim() : '';
    // Rationale is the "why" — the whole point of the drill-in.
    // Fall back to a stub if the model forgets it; better than
    // dropping an otherwise-valid entry.
    const rationale = rationaleRaw || '(no rationale provided)';
    const confRaw = typeof entry.confidence === 'number' ? entry.confidence : NaN;
    const confidence = Number.isFinite(confRaw)
      ? Math.max(0, Math.min(1, confRaw))
      : 0.5;
    const labelRaw = typeof entry.label === 'string' ? entry.label.trim() : '';
    const label = labelRaw || synthLabel(prompt || rationale);
    suggestions.push({
      kind,
      label,
      confidence,
      rationale,
      ...(kind === 'action' ? { prompt } : {}),
    });
  }

  return {
    suggestions,
    displayText: text.replace(last[0], '').trimEnd(),
  };
}

function synthLabel(prompt: string): string {
  const head = prompt.split(/[.!?\n]/, 1)[0] ?? prompt;
  return head.length > 60 ? `${head.slice(0, 57)}…` : head;
}

/**
 * During streaming we don't know where the suggestion block ends, so
 * we hide everything from the first ` ```pyric-suggestion ` fence
 * onward in the rendered text. Once the block fully arrives and the
 * stream ends, `extractSuggestion` parses it cleanly.
 */
export function stripSuggestionDuringStream(text: string): string {
  // Match any `pyric`-prefixed fence variant — same tolerance as the
  // post-stream parser, so the user never sees the JSON tail.
  const m = text.match(/```pyric[a-z_-]*/i);
  return m && m.index !== undefined ? text.slice(0, m.index).trimEnd() : text;
}

export interface ExplainContext {
  rules: string;
  /**
   * Sandbox-script body. The script editor was retired with the
   * interpreter; we keep the field shape so MCP consumers don't
   * break and always populate it with an empty string.
   */
  code: string;
  appSource: string;
  /** Most-recent denials, freshest first. */
  recentDenials: { op: string; auth: string; message: string }[];
}

/**
 * Snapshot the workspace at call time so the explanation reflects
 * the state when the user clicked, not a later edit. Pure-function
 * helper — no React, no provider call.
 */
export function captureExplainContext(): ExplainContext {
  const ws = useWorkspaceStore.getState();
  const recentDenials = useRuntimeStore.getState().liveDenials.slice(-5).map((d) => ({
    op: d.op,
    auth: d.auth,
    message: d.message,
  }));
  return {
    rules: ws.rules,
    code: '',
    appSource: ws.appSource,
    recentDenials,
  };
}

/**
 * Build the user-facing prompt for an explanation. Pure function.
 * MCP-reusable.
 */
/**
 * Per-tool framing so the model's analysis focuses on THIS call's
 * specifics — not generic Firebase observations and not a denial
 * report (the prior behavior was leaking denial context into every
 * tool drill-in regardless of the call type).
 *
 * The drill-in is "the user is reading about this one call." The
 * framing should orient the analysis to:
 *   - what this specific call did (quote values + changes)
 *   - whether the change is correct given the user's intent
 *   - what to improve about THIS call next
 *
 * Denials are demoted to "optional context" — surfaced only when
 * directly relevant to the call (runOnce in particular).
 */
function toolFraming(call: ToolCall): string {
  const name = call.name;
  if (name === 'writeRules') {
    return [
      `You are explaining a single \`writeRules\` call. The user is reading the drill-in for this specific rules edit.`,
      `Focus on:`,
      `  1. WHAT THIS EDIT CHANGED — quote specific clauses added / removed / tightened. The \`diff\` numbers in the result tell you scope.`,
      `  2. WHETHER THE NEW RULES ARE CORRECT — read each \`match\` block and \`allow\` clause against the workspace's app + sandbox code. Are there over-permissive paths? Missing validations? Speculative checks for fields the app never writes?`,
      `  3. ONE-NEXT-STEP — what to improve about THIS rules source. Tighten a clause, add a missing validation, simplify a redundant check.`,
      `Do NOT pivot into a denial report. Denials may appear as optional context below — use them only if a recent denial directly clarifies whether a rule clause is doing its job. Skip them otherwise.`,
    ].join('\n');
  }
  if (name === 'writeApp') {
    return [
      `You are explaining a single \`writeApp\` call. The user is reading the drill-in for this specific TSX edit.`,
      `Focus on:`,
      `  1. WHAT THE EDIT CHANGED in the App component — components added, hooks changed, behavior introduced. Quote specific function / hook names.`,
      `  2. WHETHER THE CHANGE IS CORRECT — does the app produce ops the rules accept? Does it use \`FieldValue.serverTimestamp()\` instead of \`Timestamp.now()\` for created/updated fields? Does it handle \`SandboxError\` / \`permission-denied\` errors? Is there UI for the security demonstration the user is teaching?`,
      `  3. ONE-NEXT-STEP — concrete improvement to THIS App source: tighten an effect, surface a denial more clearly, switch a client timestamp to a server timestamp, etc.`,
      `Do NOT explain rules denials unless they're the direct consequence of this app edit.`,
    ].join('\n');
  }
  if (name === 'writeCode') {
    return [
      `You are explaining a single \`writeCode\` call. The user is reading the drill-in for this specific sandbox-script edit.`,
      `Focus on:`,
      `  1. WHAT THE SCRIPT NOW DOES — quote the operations it issues (creates, updates, reads). The script runs once via \`runOnce\` to demonstrate behavior.`,
      `  2. WHETHER THE SCRIPT IS CORRECT — does it cover both success and denial cases the user wanted to demonstrate? Are auth identities right? Does it use \`FieldValue.serverTimestamp()\` where appropriate?`,
      `  3. ONE-NEXT-STEP — add a missing test case, fix an identity mismatch, etc.`,
    ].join('\n');
  }
  if (name === 'runOnce') {
    return [
      `You are explaining a single \`runOnce\` call. The user is reading the drill-in for this specific sandbox execution.`,
      `Focus on:`,
      `  1. WHAT EXECUTED — quote ops issued + their results. Note denials that fired during this run AND whether they're the rule working as intended or a script bug.`,
      `  2. WHETHER THE RESULT MATCHES INTENT — does the run prove what the user wanted to demonstrate?`,
      `  3. ONE-NEXT-STEP — patch the script, tighten the rules, or accept the result.`,
    ].join('\n');
  }
  // Generic tool — fall back to the original framing.
  return `You are explaining a single tool call (\`${name}\`) to a developer learning Firestore Security Rules and the Firebase Agent SDK. Be concrete: quote specific field names and values. Keep it tight — at most four short paragraphs.`;
}

export function buildExplainPrompt(call: ToolCall, ctx: ExplainContext): string {
  const sections: string[] = [];

  sections.push(toolFraming(call));

  sections.push('');
  sections.push('── TOOL CALL ──');
  sections.push(`name: ${call.name}`);
  if (call.summary) sections.push(`summary: ${call.summary}`);
  if (call.ok !== undefined) sections.push(`ok: ${call.ok}`);
  sections.push(`args: ${call.argsJson || '{}'}`);
  if (call.resultJson) sections.push(`result: ${call.resultJson}`);
  sections.push('── END TOOL CALL ──');

  sections.push('');
  sections.push('── CURRENT WORKSPACE ──');
  sections.push('Rules:');
  sections.push(ctx.rules || '(empty)');
  sections.push('');
  sections.push('Sandbox code:');
  sections.push(ctx.code || '(empty)');
  sections.push('');
  sections.push('App source:');
  sections.push(ctx.appSource || '(empty)');
  sections.push('── END WORKSPACE ──');

  // Recent denials surface as *optional* context, clearly framed
  // as secondary — the model is told above to use them only when
  // directly relevant. `runOnce` analyses still naturally consume
  // them; the write* analyses ignore them unless the model finds
  // a direct connection.
  if (ctx.recentDenials.length > 0) {
    sections.push('');
    sections.push('── CONTEXT: recent denials in session (use only when directly relevant) ──');
    for (const d of ctx.recentDenials) {
      sections.push(`- ${d.op} · auth: ${d.auth} · ${d.message}`);
    }
    sections.push('── END CONTEXT ──');
  }

  sections.push(SUGGESTION_INSTRUCTION);
  return sections.join('\n');
}

/**
 * Build the prompt for explaining a single sandbox denial. Same
 * `ExplainContext` (rules + sandbox code + app source) — the model
 * needs to see all three to decide whether the denial is the rule
 * working as intended, an app bug, or a rule bug.
 */
export function buildExplainDenialPrompt(
  denial: DenialBlurb,
  ctx: ExplainContext,
): string {
  const sections: string[] = [];

  sections.push(
    `You are explaining a single Firestore rules denial to a developer. Walk them through three things, in plain language: (1) WHICH clause of the rules rejected the request and why, (2) whether the app's code appears to anticipate this denial or was caught off-guard, (3) the most likely fix — patch the rules, patch the app, or accept that the rule is doing its job. Quote specific paths, field names, and clause text. Keep it tight: at most four short paragraphs.`,
  );

  sections.push('');
  sections.push('── DENIAL ──');
  sections.push(`op: ${denial.op}`);
  sections.push(`auth: ${denial.auth}`);
  sections.push(`classification: ${denial.classification} (${denial.classificationReason})`);
  sections.push(`message: ${denial.message}`);
  sections.push('request:');
  sections.push(JSON.stringify(denial.request, null, 2));
  sections.push('── END DENIAL ──');

  sections.push('');
  sections.push('── CURRENT WORKSPACE ──');
  sections.push('Rules:');
  sections.push(ctx.rules || '(empty)');
  sections.push('');
  sections.push('Sandbox code:');
  sections.push(ctx.code || '(empty)');
  sections.push('');
  sections.push('App source:');
  sections.push(ctx.appSource || '(empty)');
  sections.push('── END WORKSPACE ──');

  sections.push(SUGGESTION_INSTRUCTION);
  return sections.join('\n');
}

/**
 * Result shape returned by `runExplain` / `runExplainDenial`. `text`
 * has the suggestion fence stripped; `suggestions` carries the
 * parsed follow-up entries (empty array when the model didn't emit
 * any or the block was malformed).
 */
export interface ExplainResult {
  text: string;
  thinking: string;
  telemetry: ExplainTelemetry;
  suggestions: SuggestedPrompt[];
}

export interface ExplainTelemetry {
  providerId: string;
  modelId: string;
  modelLabel: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** Provider-returned exact cost (OpenRouter), or null. */
  costUsd: number | null;
  /** True when `costUsd` was computed locally from a pricing table
   *  rather than returned by the provider. */
  costEstimated: boolean;
}

/**
 * Run the explanation against the user's active provider. Streams
 * text via `onChunk`. Resolves with the final text + telemetry.
 *
 * Reuses the same `CallbackProvider` instance the agent loop uses, so
 * the user's BYOK key is consumed identically and the cost shows up
 * on the same billing account.
 */
export interface ExplainStreamCallbacks {
  onText: (chunk: string) => void;
  /** Fired when the model emits a thinking-part chunk. Optional —
   *  most non-reasoning models never call this. */
  onThinking?: (chunk: string) => void;
}

export async function runExplain(
  call: ToolCall,
  callbacks: ExplainStreamCallbacks,
  signal: AbortSignal,
): Promise<ExplainResult> {
  const ctx = captureExplainContext();
  return runExplainWithPrompt(buildExplainPrompt(call, ctx), callbacks, signal);
}

/** Denial variant — same plumbing, different prompt. */
export async function runExplainDenial(
  denial: DenialBlurb,
  callbacks: ExplainStreamCallbacks,
  signal: AbortSignal,
): Promise<ExplainResult> {
  const ctx = captureExplainContext();
  return runExplainWithPrompt(buildExplainDenialPrompt(denial, ctx), callbacks, signal);
}

/**
 * Batched denial variant — explains a whole batch of denials in one
 * model call. The prompt asks the model to look across the set,
 * group by root cause where it sees one ("three of these are the
 * same auth bug"), and emit suggestions that resolve the whole
 * batch rather than one denial at a time.
 */
export async function runExplainDenialsBatch(
  denials: readonly DenialBlurb[],
  callbacks: ExplainStreamCallbacks,
  signal: AbortSignal,
): Promise<ExplainResult> {
  const ctx = captureExplainContext();
  return runExplainWithPrompt(buildExplainDenialsBatchPrompt(denials, ctx), callbacks, signal);
}

export function buildExplainDenialsBatchPrompt(
  denials: readonly DenialBlurb[],
  ctx: ExplainContext,
): string {
  const sections: string[] = [];

  sections.push(
    `You are explaining a batch of ${denials.length} Firestore rules denial${denials.length === 1 ? '' : 's'} to a developer. Look across the whole set. If multiple denials share a root cause (same auth bug, same field mismatch, same missing rule clause), say so explicitly and treat them as one issue. For each distinct issue, walk through (1) WHICH clause of the rules rejected the request and why, (2) whether the app's code appears to anticipate this denial or was caught off-guard, (3) the most likely fix — patch the rules, patch the app, or accept that the rule is doing its job. Quote specific paths, field names, and clause text. Keep it tight: a short paragraph per issue, plus a summary line at the top.`,
  );

  sections.push('');
  sections.push(`── ${denials.length} DENIAL${denials.length === 1 ? '' : 'S'} ──`);
  denials.forEach((d, i) => {
    sections.push('');
    sections.push(`[${i + 1}] op: ${d.op}`);
    sections.push(`    auth: ${d.auth}`);
    sections.push(`    classification: ${d.classification} (${d.classificationReason})`);
    sections.push(`    message: ${d.message}`);
    sections.push(`    request: ${JSON.stringify(d.request)}`);
  });
  sections.push('── END DENIALS ──');

  sections.push('');
  sections.push('── CURRENT WORKSPACE ──');
  sections.push('Rules:');
  sections.push(ctx.rules || '(empty)');
  sections.push('');
  sections.push('Sandbox code:');
  sections.push(ctx.code || '(empty)');
  sections.push('');
  sections.push('App source:');
  sections.push(ctx.appSource || '(empty)');
  sections.push('── END WORKSPACE ──');

  sections.push(SUGGESTION_INSTRUCTION);
  return sections.join('\n');
}

/**
 * Shared streaming + cost-resolution body. Both `runExplain` and
 * `runExplainDenial` call into this once they've built the
 * appropriate prompt — keeps the LLM call, usage extraction, and
 * pricing logic in one place.
 */
async function runExplainWithPrompt(
  prompt: string,
  callbacks: ExplainStreamCallbacks,
  signal: AbortSignal,
): Promise<ExplainResult> {
  const llm = useLlmStore.getState();
  const provider = PROVIDERS[llm.providerId];
  const model = provider.models.find((m) => m.id === llm.modelId);
  const modelLabel = model?.label ?? llm.modelId;

  // Use `chatWithTools` with no tools rather than `ask` so we get
  // usage metadata + provider details back uniformly across both
  // Gemini and OpenRouter providers (their `ask` paths report less).
  const messages: ProviderChatMessage[] = [{ role: 'user', text: prompt }];

  let text = '';
  let thinking = '';
  const start = performance.now();
  const result: ProviderTurnResult = await provider.provider.chatWithTools!(
    messages,
    [],
    {
      onText: (chunk) => {
        text += chunk;
        callbacks.onText(chunk);
      },
      onThinking: (chunk) => {
        thinking += chunk;
        callbacks.onThinking?.(chunk);
      },
      onToolCall: () => {},
      signal,
    },
  );
  const durationMs = performance.now() - start;

  const tokensIn = result.usage?.promptTokens ?? 0;
  const tokensOut = result.usage?.outputTokens ?? 0;
  const cachedTokens = result.usage?.cachedTokens ?? 0;
  // OpenRouter returns `usage.cost` directly (we ask for it via
  // `usage.include` on the request) — real money, not estimated.
  // Gemini doesn't return cost; estimate from the local pricing
  // table (same table + cacheRead discount admin-compat-browser
  // uses). Unknown Gemini slug → costUsd stays null, UI hides it.
  const providerCost = result.usage?.costUsd;
  let costUsd: number | null;
  let costEstimated: boolean;
  if (typeof providerCost === 'number') {
    costUsd = providerCost;
    costEstimated = false;
  } else if (llm.providerId === 'gemini') {
    costUsd = estimateGeminiCostUsd(llm.modelId, {
      promptTokens: tokensIn,
      outputTokens: tokensOut,
      cachedTokens,
    });
    costEstimated = costUsd !== null;
  } else {
    costUsd = null;
    costEstimated = false;
  }

  const rawText = text || result.text || '';
  const { suggestions, displayText } = extractSuggestions(rawText);

  return {
    text: displayText,
    thinking,
    suggestions,
    telemetry: {
      providerId: llm.providerId,
      modelId: llm.modelId,
      modelLabel,
      durationMs,
      tokensIn,
      tokensOut,
      costUsd,
      costEstimated,
    },
  };
}
