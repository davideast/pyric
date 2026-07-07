#!/usr/bin/env bun
/** One-off: measure the static per-iteration prefix (system prompt + tool
 *  schemas) that the ReAct loop re-sends on every turn. No LLM. */
if (typeof (globalThis as { window?: unknown }).window === 'undefined') {
  const s = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: { getItem: (k: string) => s.get(k) ?? null, setItem: (k: string, v: string) => void s.set(k, v), removeItem: (k: string) => void s.delete(k), clear: () => s.clear(), key: () => null, get length() { return s.size; } },
  };
}
const { buildToolRegistry } = await import('~/lib/tools');
const { buildSystemPrompt } = await import('~/lib/agent/system-prompt');
const tok = (s: string) => Math.round(s.length / 4); // ~4 chars/token

const reg = buildToolRegistry();
const decls = reg.list().map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
const toolsJson = JSON.stringify(decls);
const sysOn = buildSystemPrompt({ diagnosticsEnabled: true });
const sysOff = buildSystemPrompt({ diagnosticsEnabled: false });

console.log(`tools registered:        ${decls.length}`);
console.log(`tool schemas (JSON):     ${toolsJson.length} chars ≈ ${tok(toolsJson)} tok`);
console.log(`system prompt (diag on): ${sysOn.length} chars ≈ ${tok(sysOn)} tok`);
console.log(`system prompt (diag off):${sysOff.length} chars ≈ ${tok(sysOff)} tok`);
console.log(`── static prefix re-sent EVERY iteration ≈ ${tok(sysOn) + tok(toolsJson)} tok`);
console.log(`   × ~11 iterations (observed Kimi react) ≈ ${(tok(sysOn) + tok(toolsJson)) * 11} tok of pure repetition`);
// biggest single tool schema
const bySize = reg.list().map((t) => ({ name: t.name, tok: tok(JSON.stringify({ description: t.description, parameters: t.parameters })) })).sort((a, b) => b.tok - a.tok);
console.log(`top tool-schema sizes:   ${bySize.slice(0, 5).map((t) => `${t.name}=${t.tok}tok`).join(', ')}`);
