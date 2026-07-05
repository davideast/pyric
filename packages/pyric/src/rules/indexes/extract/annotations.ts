/**
 * Pure parser for `@firestore-*` annotations in JSDoc comment blocks.
 *
 * Recognized syntax (Layer 2, locked from the P-prune v1 scope):
 *
 *   @firestore-mutex { fieldA, fieldB, fieldC }
 *     — at most one of these fields can be active in any extracted
 *       shape. Multiple lines = multiple independent groups.
 *
 *   @firestore-required fieldA, fieldB
 *     — every extracted shape must include these fields.
 *
 *   @firestore-budget N
 *     — soft cap on emitted index entries. Surfaces as a warning when
 *       exceeded; does not drop entries.
 *
 * Annotations are additive — the absence of any tag falls back to
 * Layer 1 behavior. Malformed tags degrade gracefully: a warning is
 * emitted and the offending tag is ignored.
 *
 * This module does no AST work — it operates on raw comment text.
 * Pairing comments with function declarations happens in
 * `annotation-collect.ts`.
 */

export interface Annotations {
  /** Each set is one mutex group. A combo violates a group if 2+ fields hit. */
  mutexGroups: Set<string>[];
  /** Fields every extracted shape must include. */
  required: Set<string>;
  /** Soft cap on emitted entries. Undefined = no cap. */
  budget?: number;
}

export type AnnotationWarningCode =
  | 'unknown-firestore-tag'
  | 'malformed-mutex'
  | 'malformed-required'
  | 'malformed-budget';

export interface AnnotationWarning {
  code: AnnotationWarningCode;
  /** The tag name without the leading `@`, e.g. "firestore-mutex". */
  tag: string;
  message: string;
}

export interface ParseAnnotationsResult {
  annotations: Annotations;
  warnings: AnnotationWarning[];
}

const KNOWN_TAGS = new Set([
  'firestore-mutex',
  'firestore-required',
  'firestore-budget',
]);

/**
 * Parse `@firestore-*` tags out of a comment block. Returns an empty
 * `Annotations` with no warnings when the input contains no firestore
 * tags — this is the additive fallback.
 */
export function parseAnnotations(commentText: string): ParseAnnotationsResult {
  const annotations: Annotations = { mutexGroups: [], required: new Set() };
  const warnings: AnnotationWarning[] = [];

  if (!commentText) return { annotations, warnings };

  // Normalize JSDoc syntax so the trailing `*/` and per-line ` * `
  // don't leak into our value captures. We don't care about the
  // comment structure — only the @firestore-* tags and their args.
  commentText = stripCommentMarkers(commentText);

  // ── @firestore-mutex { f1, f2, ... } ──────────────────────────────────
  // Use a regex that captures the brace contents. Empty braces or no
  // braces at all are malformed.
  const mutexAll = commentText.matchAll(/@firestore-mutex\b([^\n]*)/g);
  for (const m of mutexAll) {
    const tail = m[1];
    const braceMatch = tail.match(/\{\s*([^}]*?)\s*\}/);
    if (!braceMatch) {
      warnings.push({
        code: 'malformed-mutex',
        tag: 'firestore-mutex',
        message: `@firestore-mutex requires a brace-delimited field list, e.g. \`@firestore-mutex { a, b, c }\` — got: ${tail.trim() || '(empty)'}`,
      });
      continue;
    }
    const fields = splitFields(braceMatch[1]);
    if (fields.length === 0) {
      warnings.push({
        code: 'malformed-mutex',
        tag: 'firestore-mutex',
        message: '@firestore-mutex group is empty — at least one field is required.',
      });
      continue;
    }
    annotations.mutexGroups.push(new Set(fields));
  }

  // ── @firestore-required f1, f2 ────────────────────────────────────────
  const requiredAll = commentText.matchAll(/@firestore-required\b([^\n@]*)/g);
  for (const m of requiredAll) {
    const fields = splitFields(m[1]);
    if (fields.length === 0) {
      warnings.push({
        code: 'malformed-required',
        tag: 'firestore-required',
        message: '@firestore-required needs at least one field, e.g. `@firestore-required tenantId`.',
      });
      continue;
    }
    for (const f of fields) annotations.required.add(f);
  }

  // ── @firestore-budget N ───────────────────────────────────────────────
  const budgetAll = [...commentText.matchAll(/@firestore-budget\b([^\n@]*)/g)];
  for (const m of budgetAll) {
    const raw = m[1].trim();
    const parsed = Number(raw);
    if (!raw || !Number.isInteger(parsed) || parsed <= 0) {
      warnings.push({
        code: 'malformed-budget',
        tag: 'firestore-budget',
        message: `@firestore-budget needs a positive integer, e.g. \`@firestore-budget 12\` — got: ${raw || '(empty)'}`,
      });
      continue;
    }
    // Last write wins if multiple budget tags appear — pick the
    // tightest cap so the agent sees the strictest constraint.
    annotations.budget = annotations.budget === undefined ? parsed : Math.min(annotations.budget, parsed);
  }

  // ── Unknown @firestore-* tags ─────────────────────────────────────────
  // Catch typos like @firestore-mutext or @firestore-mutexx so the
  // agent doesn't silently skip an intended annotation.
  const allTags = commentText.matchAll(/@(firestore-[a-zA-Z0-9_-]+)/g);
  const seenUnknown = new Set<string>();
  for (const m of allTags) {
    const tag = m[1];
    if (KNOWN_TAGS.has(tag)) continue;
    if (seenUnknown.has(tag)) continue;
    seenUnknown.add(tag);
    warnings.push({
      code: 'unknown-firestore-tag',
      tag,
      message: `Unknown annotation '@${tag}'. Recognized: @firestore-mutex, @firestore-required, @firestore-budget.`,
    });
  }

  return { annotations, warnings };
}

/**
 * Split a comma-separated field list. Trims whitespace, drops empties,
 * and strips trailing commas. Field identifiers themselves are
 * preserved as written — no validation against actual source.
 */
function splitFields(s: string): string[] {
  return s.split(',').map(f => f.trim()).filter(Boolean);
}

/**
 * Strip `/*`, `* /`, leading per-line ` * `, and `//` markers so the
 * downstream regexes don't pick them up as part of value captures.
 * Preserves newlines so multi-line tags still split correctly.
 */
function stripCommentMarkers(s: string): string {
  // Remove block-comment open/close.
  s = s.replace(/\/\*+/g, '').replace(/\*+\//g, '');
  // Remove leading ` * ` (and the bare ` *`) on each line.
  s = s.replace(/^[ \t]*\*+[ \t]?/gm, '');
  // Remove `//` line-comment markers (rare for JSDoc, but legal).
  s = s.replace(/^[ \t]*\/\/[ \t]?/gm, '');
  return s;
}
