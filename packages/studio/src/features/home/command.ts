/**
 * Home command input — the deterministic router core (specs/home.md).
 *
 * PURE. Matches free text against navigation targets only: the shell tabs
 * (fuzzy) and the deep-link patterns the URL codec already understands
 * (Firestore doc/collection paths, `gs://`/object paths, auth uids, traffic
 * denial ids). Results contain actions and ROUTES only — never settings or
 * configuration (M4). No AI here; when a key exists, NL rides a separate
 * layer over the same targets (M5) — out of scope for Home v1.
 */

export interface CommandTarget {
  tab: string;
  rest?: string[];
  query?: Record<string, string>;
}

export interface CommandResult {
  /** Stable per-result id (React key). */
  id: string;
  label: string;
  /** Quiet second line: what the action does / where it goes. */
  hint: string;
  target: CommandTarget;
}

export interface CommandRoute {
  id: string;
  label: string;
  description: string;
}

/** Case-insensitive subsequence match ("fs" → "Firestore"). */
export function fuzzyIncludes(needle: string, haystack: string): boolean {
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let i = 0;
  for (const ch of h) {
    if (ch === n[i]) i++;
    if (i === n.length) return true;
  }
  return i === n.length;
}

const MAX_RESULTS = 7;

/**
 * Match `input` against tabs + deep-link patterns. Deterministic, ordered:
 * exact/prefix tab matches, then deep links, then fuzzy tab matches.
 * Settings never appears in results (M4: results are actions and routes,
 * never configuration).
 */
export function matchCommands(
  input: string,
  routes: readonly CommandRoute[],
): CommandResult[] {
  const q = input.trim();
  if (!q) return [];

  const navigable = routes.filter((r) => r.id !== 'settings');
  const exact: CommandResult[] = [];
  const fuzzy: CommandResult[] = [];
  const deep: CommandResult[] = [];

  const [head = '', ...tailWords] = q.split(/\s+/);
  const tail = tailWords.join(' ');

  for (const r of navigable) {
    const asResult: CommandResult = {
      id: `tab:${r.id}`,
      label: `Go to ${r.label}`,
      hint: r.description,
      target: { tab: r.id },
    };
    const label = r.label.toLowerCase();
    if (label.startsWith(q.toLowerCase())) exact.push(asResult);
    else if (fuzzyIncludes(q, r.label)) fuzzy.push(asResult);

    // "<tab> <rest>" → deep link into that tab's rest space.
    if (tail && (label === head.toLowerCase() || label.startsWith(head.toLowerCase()))) {
      const rest = tail.split('/').filter(Boolean);
      if (r.id === 'firestore' || r.id === 'storage') {
        deep.push({
          id: `deep:${r.id}:${tail}`,
          label: `Open /${rest.join('/')} in ${r.label}`,
          hint: r.id === 'firestore' ? 'Firestore path' : 'Storage object path',
          target: { tab: r.id, rest },
        });
      } else if (r.id === 'auth') {
        deep.push({
          id: `deep:auth:${tail}`,
          label: `Open user ${tail} in Auth`,
          hint: 'Auth uid',
          target: { tab: 'auth', rest: [tail] },
        });
      } else if (r.id === 'traffic') {
        deep.push({
          id: `deep:traffic:${tail}`,
          label: `Focus denial ${tail} in Traffic`,
          hint: 'Traffic denial id',
          target: { tab: 'traffic', query: { denial: tail } },
        });
      }
    }
  }

  // A gs:// object path → Storage.
  const gs = q.match(/^gs:\/\/[^/]+\/(.+)$/);
  if (gs) {
    const rest = gs[1].split('/').filter(Boolean);
    deep.unshift({
      id: `deep:storage:${gs[1]}`,
      label: `Open ${gs[1]} in Storage`,
      hint: 'Storage object path',
      target: { tab: 'storage', rest },
    });
  } else if (q.includes('/') && !q.includes(' ')) {
    // A bare slashed path → Firestore drill (the most common deep link).
    const rest = q.split('/').filter(Boolean);
    if (rest.length) {
      deep.push({
        id: `deep:firestore:${q}`,
        label: `Open /${rest.join('/')} in Firestore`,
        hint: 'Firestore path',
        target: { tab: 'firestore', rest },
      });
    }
  }

  return [...exact, ...deep, ...fuzzy].slice(0, MAX_RESULTS);
}
