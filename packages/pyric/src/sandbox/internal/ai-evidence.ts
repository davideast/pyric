/** Payload-free observations. Routed identity is distinct from backend-reported identity. */
export interface AiEvidence {
  requestedModel: string;
  routedModel?: string;
  reportedModel?: string;
  engine: 'scripted' | 'openai' | 'gemini' | 'custom' | 'unknown';
  endpoint?: string;
  mappingReason?: string;
  usageSource: 'backend' | 'estimated' | 'scripted' | 'unknown';
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  durationMs?: number;
  firstChunkMs?: number;
}
// Out-of-band metadata never changes Firebase response envelopes.
const key = Symbol.for('pyric.ai-evidence');
const store = globalThis as { [key]?: WeakMap<object, Partial<AiEvidence>> };
const evidence = store[key] ??= new WeakMap<object, Partial<AiEvidence>>();
export function setAiEvidence<T extends object>(value: T, detail: Partial<AiEvidence>): T {
  evidence.set(value, Object.freeze({ ...detail }));
  return value;
}
export function getAiEvidence(value: object): Partial<AiEvidence> | undefined { return evidence.get(value); }
/** Strip credentials, paths, and query parameters from diagnostic endpoints. */
export function aiEndpoint(value?: string): string | undefined {
  if (!value) return;
  try { return new URL(value).origin; } catch { return 'Same-origin proxy'; }
}

/** Explicit worker envelope; the page removes it before enhancing Firebase results. */
export function packAiEvidence<T extends object>(response: T): T & { __pyricAi?: Partial<AiEvidence> } {
  return { ...response, __pyricAi: getAiEvidence(response) };
}
export function unpackAiEvidence<T extends object>(response: T & { __pyricAi?: Partial<AiEvidence> }): T {
  const { __pyricAi, ...plain } = response;
  return setAiEvidence(plain as T, __pyricAi ?? {});
}
