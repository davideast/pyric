/**
 * RulesState — the deployed rules source and its parsed AST (ADR-0009,
 * PR B3, decision 5).
 *
 * One holder for what used to be spread across the engine facade as
 * `rulesSource`, `parsedRulesCache`, and the `rulesAst()` accessor.
 * Shared by the rules-gated read paths (RulesReadEngine's query-proof
 * gate) and the write engine's simulate path.
 *
 * RULES-B11 — the AST cache exists because the query-proof gate needs
 * the matched `list` rule's condition AST on EVERY list read;
 * re-parsing the (unchanging) rules source per read would be O(source)
 * on the listener hot path. The cache is keyed on the exact source
 * string so `deployRules` / `seed` invalidate it for free by calling
 * {@link set}.
 */
import { parseToAST, type FirestoreRules } from 'pyric/rules/internal';

export class RulesState {
  private currentSource: string;

  /**
   * RULES-B11 — parsed-AST cache, keyed on the exact source string.
   * `ast` is `null` when the source doesn't parse (the simulate() call
   * then reports the failure on its own).
   */
  private parsedCache: { source: string; ast: FirestoreRules | null } | null = null;

  constructor(initialSource: string) {
    this.currentSource = initialSource;
  }

  /** The currently deployed rules source. */
  get source(): string {
    return this.currentSource;
  }

  /**
   * Install a new rules source (seed / deployRules). Cache invalidation
   * is implicit: {@link ast} re-parses when the cached source string no
   * longer matches — installing the byte-identical source keeps the
   * cached AST warm.
   */
  set(source: string): void {
    this.currentSource = source;
  }

  /**
   * The parsed rules AST for the current source, cached per source
   * string. Returns `null` when the source doesn't parse.
   */
  ast(): FirestoreRules | null {
    if (this.parsedCache?.source !== this.currentSource) {
      this.parsedCache = {
        source: this.currentSource,
        ast: parseToAST(this.currentSource),
      };
    }
    return this.parsedCache.ast;
  }
}
