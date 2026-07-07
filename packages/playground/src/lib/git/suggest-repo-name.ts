import { validateRepoName } from './branch-policy';

const FALLBACK = 'playground-project';

/** Words that carry no identity in a repo name — prompt scaffolding
 *  ("create an app that…") and connective tissue. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'with', 'without', 'for', 'of', 'to',
  'in', 'on', 'at', 'by', 'from', 'into', 'that', 'this', 'these', 'those',
  'is', 'are', 'be', 'can', 'must', 'should', 'will', 'where', 'when', 'while',
  'create', 'make', 'build', 'building', 'write', 'add', 'want', 'like',
  'app', 'application', 'website', 'site', 'project', 'simple', 'basic',
  'called', 'named', 'style', 'top-down', 'users', 'user', 'players', 'player',
  'each', 'their', 'them', 'they', 'it', 'its', 'my', 'me', 'i', 'we', 'our',
  'using', 'use', 'has', 'have', 'need', 'needs',
]);

const MAX_WORDS = 4;
const MAX_LENGTH = 40;

function sanitize(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/[-.]{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/^[-._]+|[-._]+$/g, '');
}

/** Words of a prompt with punctuation stripped, in order. */
function words(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ''))
    .filter(Boolean);
}

/** A name the prompt itself declares: `called X`, `named X`, or a
 *  "quoted phrase" — the strongest identity signal. Takes up to
 *  MAX_WORDS words, stopping at the first stop-word (the name is over
 *  when the sentence's connective tissue resumes: "called math quest
 *  where players…" → math quest). */
function declaredName(prompt: string): string[] | null {
  const quoted = prompt.match(/["“']([^"”']{2,60})["”']/);
  if (quoted) {
    const ws = words(quoted[1]!).slice(0, MAX_WORDS);
    if (ws.length > 0) return ws;
  }
  const m = prompt.toLowerCase().match(/\b(?:called|named|titled)\s+(.{2,60})/);
  if (!m) return null;
  const out: string[] = [];
  for (const w of words(m[1]!)) {
    if (STOP_WORDS.has(w)) break;
    out.push(w);
    if (out.length === MAX_WORDS) break;
  }
  return out.length > 0 ? out : null;
}

/**
 * Derive a SHORT GitHub-safe repo name from a session prompt.
 *
 * A repo name is an identity, not a summary — slugging the whole
 * prompt produced 100-char monsters like
 * `create-a-top-down-jrpg-style-game-called-math-quest-.-players-…`.
 * Strategy: prefer a name the prompt itself declares (`called X`,
 * quoted), else the first few content words with prompt scaffolding
 * (create/build/app/with/…) removed. Hard caps: 4 words / 40 chars.
 */
export function suggestRepoNameFromPrompt(prompt: string): string {
  const declared = declaredName(prompt);
  const picked =
    declared ??
    words(prompt)
      .filter((w) => !STOP_WORDS.has(w))
      .slice(0, MAX_WORDS);

  const slug = sanitize(picked.join('-'));
  if (!slug) return FALLBACK;

  try {
    validateRepoName(slug);
    return slug;
  } catch {
    return FALLBACK;
  }
}
