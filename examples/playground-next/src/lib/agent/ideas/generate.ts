/**
 * Dynamic "what to build next" idea generation for the Firebase > Ideas
 * tab (feature #4, made dynamic).
 *
 * Token-efficiency strategy (the whole point):
 *   1. STANDALONE call, never the agent loop. A single-turn, no-tools
 *      inference (like `enhancePrompt`) — so we never re-send the ~2.8k
 *      system prompt + every tool schema that an in-loop tool call costs.
 *   2. A DIGEST, not the raw material. We derive compact, high-signal
 *      inputs that already live in memory: the rules body, a file
 *      manifest (paths only), the App.tsx import/call-site skeleton, a
 *      per-collection schema summary from the sandbox snapshot, and the
 *      user's own prompts (never assistant streams / tool dumps). ~1k in.
 *   3. CACHE by a content hash of the digest (see `hashDigest`); the tab
 *      only regenerates when the app state actually changed. A near-empty
 *      digest (fresh session) short-circuits to `empty` so we spend ZERO
 *      tokens and fall back to the curated starter ideas.
 */
import type { NormalizedRequest } from '@inbrowser/relay';
import { createInference } from '~/lib/llm/inference';
import { listAllFiles } from '~/lib/files/file-tree';
import { WORKSPACE_ROOT } from '~/lib/store/files';
import { readFirestoreState } from '~/lib/sandbox/runtime';
import { useWorkspaceStore } from '~/lib/store/workspace';
import { useChatStore } from '~/lib/store/chat';
import type { FirebaseIdea } from '~/lib/firebase-ideas';

/** Icons the model may choose from (kept to a known set so the card
 *  renders a real Material Symbol; unknown picks fall back to `bolt`). */
const IDEA_ICONS = [
  'bolt', 'account_circle', 'checklist', 'forum', 'leaderboard',
  'dynamic_feed', 'admin_panel_settings', 'shield', 'notifications',
  'search', 'group', 'photo_library', 'payments', 'map', 'event',
  'favorite', 'chat', 'inventory_2',
];

export interface IdeasDigest {
  /** The compact context string sent to the model. */
  text: string;
  /** Stable content hash — the cache key. */
  hash: number;
  /** True when there's essentially no app state yet (skip the call). */
  empty: boolean;
}

/** FNV-1a (32-bit) — same family the persistence layer uses. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Collection template for a doc path: keep the collection segments
 *  (even indices) and replace doc ids with a wildcard. So the path
 *  chats/r1/messages/m1 becomes chats/(wild)/messages. */
function collectionTemplate(docPath: string): string {
  const segs = docPath.split('/').filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < segs.length; i += 2) {
    out.push(segs[i]!);
    if (i + 2 < segs.length) out.push('*');
  }
  return out.join('/');
}

function valueType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') {
    if ((v as { __type?: string }).__type === 'timestamp') return 'timestamp';
    return 'map';
  }
  return typeof v;
}

/** Per-collection field summary from the sandbox snapshot. One sampled
 *  doc per collection; field names + types only, never values. */
async function summarizeSchema(): Promise<string> {
  let state: Record<string, unknown>;
  try {
    state = await readFirestoreState({ maxDepth: 6 });
  } catch {
    return '';
  }
  const seen = new Map<string, string>();
  for (const [path, data] of Object.entries(state)) {
    const coll = collectionTemplate(path);
    if (!coll || seen.has(coll)) continue;
    if (!data || typeof data !== 'object') continue;
    const fields = Object.entries(data as Record<string, unknown>)
      .slice(0, 12)
      .map(([k, v]) => `${k}:${valueType(v)}`)
      .join(', ');
    seen.set(coll, fields);
    if (seen.size >= 20) break;
  }
  if (seen.size === 0) return '';
  return [...seen.entries()].map(([c, f]) => `  ${c} { ${f} }`).join('\n');
}

/** App.tsx skeleton: import lines + Firebase call sites, capped. Keeps
 *  the structural signal (what SDK surface the app uses) without the
 *  full component body. */
function summarizeApp(appSource: string): string {
  if (!appSource.trim()) return '';
  const lines = appSource.split('\n');
  const kept: string[] = [];
  const callRe = /\b(collection|doc|getDocs?|setDoc|addDoc|updateDoc|deleteDoc|onSnapshot|query|where|orderBy|getAuth|onAuthStateChanged|signIn\w*|signOut)\s*\(/;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('import ')) kept.push(t);
    else if (callRe.test(t)) kept.push(t.slice(0, 120));
    if (kept.length >= 30) break;
  }
  return kept.join('\n');
}

/** Last few USER prompts only — the intent signal. No assistant text,
 *  no tool results (those are almost all the tokens, almost no signal). */
function recentUserPrompts(): string {
  const msgs = useChatStore.getState().messages;
  const users = msgs.filter((m) => m.role === 'user').slice(-5);
  return users.map((m) => `- ${m.text.slice(0, 200)}`).join('\n');
}

/**
 * Assemble the digest from in-memory state. No network, no agent loop.
 * `empty` is true when there's nothing to reason about yet.
 */
export async function buildIdeasDigest(): Promise<IdeasDigest> {
  const ws = useWorkspaceStore.getState();
  const rules = (ws.rules ?? '').trim();
  const appSummary = summarizeApp(ws.appSource ?? '');
  const schema = await summarizeSchema();
  const prompts = recentUserPrompts();

  let files: string[] = [];
  try {
    files = (await listAllFiles(WORKSPACE_ROOT))
      .map((p) => p.replace(`${WORKSPACE_ROOT}/`, ''))
      .filter((p) => p !== 'firestore.rules')
      .slice(0, 40);
  } catch {
    /* VFS unavailable — omit the manifest */
  }

  const parts: string[] = [];
  if (files.length) parts.push(`FILES:\n${files.map((f) => `  ${f}`).join('\n')}`);
  if (rules) parts.push(`FIRESTORE RULES:\n${rules.slice(0, 2000)}`);
  if (appSummary) parts.push(`APP.tsx (imports + Firebase calls):\n${appSummary}`);
  if (schema) parts.push(`SANDBOX DATA (collection: fields):\n${schema}`);
  if (prompts) parts.push(`RECENT USER PROMPTS:\n${prompts}`);

  const text = parts.join('\n\n');
  // "Empty" = no rules authored, no app code, no data, no prompts. A
  // bare file manifest (just the two starter files) is not enough signal.
  const empty = !rules && !appSummary && !schema && !prompts;
  return { text, hash: fnv1a(text), empty };
}

const IDEAS_SYSTEM_PROMPT = [
  'You suggest what the developer should build NEXT in a Firebase playground app.',
  'You are given a compact digest of the current app: files, Firestore security rules, the App.tsx Firebase call sites, the sandbox data shape, and the user\'s recent prompts.',
  'Propose up to 5 concrete, incremental next features that fit THIS app and extend what already exists (new collections, tighter/again-relevant security rules, auth flows, realtime views, etc.). Prefer features that exercise Firestore security rules.',
  '',
  'Output ONLY a JSON array (no prose, no markdown fences) of up to 5 objects with EXACTLY these string fields:',
  '  { "icon": <one of the allowed icons>, "title": <=6 words, "tagline": one short line, "examplePrompt": a ready-to-send instruction to the build agent (2-4 sentences, name the collections + the security-rule constraint) }',
  `Allowed icons: ${IDEA_ICONS.join(', ')}.`,
  'Keep every field terse. Return [] if the app is too empty to suggest anything specific.',
].join('\n');

/** Pull the first top-level JSON array out of a model response that may
 *  carry stray prose or code fences. */
function extractJsonArray(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function toIdea(raw: unknown, index: number): FirebaseIdea | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const examplePrompt = typeof r.examplePrompt === 'string' ? r.examplePrompt.trim() : '';
  if (!title || !examplePrompt) return null;
  const icon = typeof r.icon === 'string' && IDEA_ICONS.includes(r.icon) ? r.icon : 'bolt';
  const tagline = typeof r.tagline === 'string' ? r.tagline.trim() : '';
  return {
    id: `ai-${index}-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}`,
    icon,
    title,
    tagline,
    builds: [],
    examplePrompt,
  };
}

// ─── Cache ─────────────────────────────────────────────────────────
// Keyed by the digest hash: identical app state serves the same ideas
// with zero tokens. Module-level so it survives the IdeasTab remounting
// each time the Firebase tab is (re)opened.
const ideasCache = new Map<number, FirebaseIdea[]>();

export function getCachedIdeas(hash: number): FirebaseIdea[] | undefined {
  return ideasCache.get(hash);
}
export function setCachedIdeas(hash: number, ideas: FirebaseIdea[]): void {
  ideasCache.set(hash, ideas);
}

/**
 * Parse a model response into validated ideas. Tolerates code fences and
 * stray prose around the JSON array, drops malformed entries, caps at 5.
 * Exported for testing — model output is the fragile surface.
 */
export function parseIdeasResponse(text: string): FirebaseIdea[] {
  const parsed = extractJsonArray(text);
  if (!Array.isArray(parsed)) return [];
  const ideas: FirebaseIdea[] = [];
  for (let i = 0; i < parsed.length && ideas.length < 5; i++) {
    const idea = toIdea(parsed[i], i);
    if (idea) ideas.push(idea);
  }
  return ideas;
}

export interface GenerateIdeasParams {
  providerId: string;
  modelId: string;
  apiKey: string;
  digest: string;
  signal?: AbortSignal;
}

/**
 * Run the standalone generation. Single-turn, no tools. Returns up to 5
 * validated ideas (empty array if the model declined or produced nothing
 * parseable — the caller falls back to the curated starters).
 */
export async function generateIdeas({
  providerId,
  modelId,
  apiKey,
  digest,
  signal,
}: GenerateIdeasParams): Promise<FirebaseIdea[]> {
  const client = createInference();
  const req: NormalizedRequest = {
    provider: providerId,
    model: modelId,
    apiKey,
    messages: [
      { role: 'system', text: IDEAS_SYSTEM_PROMPT },
      { role: 'user', text: digest },
    ],
    tools: [],
    toolUseEnabled: false,
    ...(signal ? { signal } : {}),
  };

  let acc = '';
  for await (const evt of client.stream(req)) {
    if (signal?.aborted) return [];
    if (evt.kind === 'text') acc += evt.chunk;
    else if (evt.kind === 'error') throw new Error(evt.message);
  }

  return parseIdeasResponse(acc);
}
