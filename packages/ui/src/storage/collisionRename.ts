/**
 * OS-copy collision renaming for uploads/drops — pure logic, no React.
 *
 * THE RULE (mirrors macOS Finder's "keep both" counter semantics, with
 * the Windows-style ` (n)` spelling the spec pins):
 *
 * 1. Split the name into `stem + ext`. The extension is the suffix from
 *    the LAST dot, only when that dot is neither the first character nor
 *    the last: `photo.png` → `photo` + `.png`; `archive.tar.gz` →
 *    `archive.tar` + `.gz`; dotfiles (`.gitignore`) and trailing-dot
 *    names (`notes.`) have NO extension — the whole name is the stem;
 *    extensionless names (`Makefile`) likewise.
 * 2. If the stem already ends in a ` (n)` counter (single space, plain
 *    decimal integer), the counter is INCREMENTED, not nested:
 *    `photo (1).png` colliding becomes `photo (2).png`, never
 *    `photo (1) (1).png`. (`photo (1) (2).png` → base `photo (1)`,
 *    counter 2 → `photo (1) (3).png`: only the final counter moves.)
 * 3. Otherwise the first candidate is ` (1)`: `photo.png` →
 *    `photo (1).png`.
 * 4. Candidates increment until one is not taken.
 *
 * A name that isn't taken is returned unchanged — the renamer only
 * fires on collision.
 */

/** `name` split as the rule defines: `ext` includes the leading dot,
 *  or is `''` when the name has no extension (dotfiles, trailing dots,
 *  extensionless names). */
export function splitStorageName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** Trailing ` (n)` counter: `photo (3)` → base `photo`, counter 3.
 *  `counter: null` when the stem carries none. */
export function parseCopyCounter(stem: string): { base: string; counter: number | null } {
  const m = /^(.*) \((\d+)\)$/.exec(stem);
  if (!m) return { base: stem, counter: null };
  return { base: m[1], counter: Number(m[2]) };
}

/**
 * Resolve one name against a set of taken sibling names. Returns the
 * name unchanged when free; otherwise the first ` (n)` candidate that
 * is free, per the module rule above.
 */
export function resolveCollision(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const { stem, ext } = splitStorageName(name);
  const { base, counter } = parseCopyCounter(stem);
  let n = counter === null ? 1 : counter + 1;
  for (;;) {
    const candidate = `${base} (${n})${ext}`;
    if (!taken.has(candidate)) return candidate;
    n += 1;
  }
}

/**
 * Resolve a whole drop/pick batch against the destination folder's
 * existing names, with OS drop semantics: collisions are detected and
 * renamed at the batch's TOP LEVEL only (the names the OS drop
 * "creates" in the destination — a plain file's name, or a dropped
 * folder's root segment). Files inside a dropped folder ride their
 * folder's rename and keep their inner structure untouched — exactly
 * like dropping `photos/` next to an existing `photos/` yields
 * `photos (1)/…` with the contents intact.
 *
 * Within one batch:
 * - all paths sharing a top-level FOLDER segment share its resolution
 *   (one dropped folder = one rename), and
 * - top-level FILES resolve individually in order, each claiming its
 *   resolved name, so two same-named files in one batch get successive
 *   counters.
 *
 * Only the destination's DIRECT children can be checked — that is all
 * the drop target (one `listAll` level) knows. Deeper paths follow GCS
 * overwrite semantics, which the folder-level rename already shields
 * in practice (a colliding folder is renamed wholesale).
 *
 * Returns resolved paths in input order.
 */
export function planBatchNames(
  relativePaths: readonly string[],
  taken: ReadonlySet<string>,
): string[] {
  const claimed = new Set(taken);
  // One resolution per dropped folder root, shared across its files.
  const folderRenames = new Map<string, string>();
  return relativePaths.map((path) => {
    const slash = path.indexOf('/');
    if (slash === -1) {
      // Top-level file: resolve individually, claim the result.
      const resolved = resolveCollision(path, claimed);
      claimed.add(resolved);
      return resolved;
    }
    const root = path.slice(0, slash);
    let renamed = folderRenames.get(root);
    if (renamed === undefined) {
      renamed = resolveCollision(root, claimed);
      claimed.add(renamed);
      folderRenames.set(root, renamed);
    }
    return `${renamed}${path.slice(slash)}`;
  });
}
