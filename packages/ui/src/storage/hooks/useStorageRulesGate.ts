import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TARGET_SYMBOL,
  parseStorageRules,
  evaluateStorageRules,
  type FirebaseStorage,
  type StorageAuth,
  type StorageRequestMethod,
  type StorageRules,
} from 'pyric/storage';
import { normalizeStoragePath } from './usePathState.js';

export type StorageRulesGateStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Where the active ruleset came from:
 * - `'option'` — the explicit `rules` option (string or pre-parsed).
 * - `'sandbox'` — the ruleset deployed on the sandbox handle
 *   (`getStorageSandbox(ctx, { rules })`), read off the handle's
 *   `StorageService`.
 * - `'none'` — no rules reachable. Every verdict allows
 *   (open-by-default, the same semantics `pyric/storage`'s
 *   enforcement layer applies when no rules are configured).
 */
export type StorageRulesSource = 'option' | 'sandbox' | 'none';

/**
 * Per-path verdict. Upload and delete are evaluated with their granular
 * Storage request methods so `request.method` policies and missing incoming
 * payload semantics remain truthful. `write` retains its historical upload
 * meaning; callers use `delete` for delete affordances.
 */
export interface StorageGateVerdict {
  read: boolean;
  write: boolean;
  /** Granular delete verdict (`request.method == 'delete'`). */
  delete: boolean;
  /** Granular create/upload verdict (`request.method == 'create'`). */
  upload: boolean;
  /**
   * Evaluator reason traces for DENIED verbs (`"no rule matches…"` /
   * `"match /… : condition false"`); empty arrays when allowed.
   * Feed into disabled-state tooltips and `data-*-reason` attributes.
   */
  reasons: { read: string[]; write: string[] };
}

export interface UseStorageRulesGateOptions {
  /**
   * Path (or paths) to pre-evaluate into `verdicts`, keyed by the
   * normalized path. Ad-hoc paths (e.g. browser rows) go through
   * `verdictFor` instead — the two are the same evaluation.
   */
  paths?: string | readonly string[];
  /**
   * Explicit rules source — raw rules text (parsed here; a malformed
   * string surfaces as `status: 'error'`) or a pre-parsed
   * `StorageRules` handle. Overrides the sandbox's deployed ruleset
   * when both exist.
   */
  rules?: string | StorageRules;
  /**
   * Identity override. `null` is anonymous; OMIT the field to use
   * the handle's own identity (the sandbox context's `auth`).
   */
  identity?: StorageAuth | null;
  /**
   * The about-to-write payload bound to `request.resource` for the
   * CREATE evaluation — pass `{ size, contentType }` when gating a
   * specific upload so size/contentType-conditioned rules evaluate
   * truthfully. When omitted, `request.resource` is unset, which is
   * absent, `upload`/`write` remain a conservative deny for payload-dependent
   * policies. Delete is evaluated independently and never receives this value.
   */
  writeResource?: { size: number; contentType?: string };
}

export interface UseStorageRulesGateResult {
  /** `'idle'` only when `storage` is null/undefined. */
  status: StorageRulesGateStatus;
  /** Where the active ruleset came from. */
  source: StorageRulesSource;
  /** Always false: `pyric/storage` handles are sandbox mirrors. */
  advisory: boolean;
  /** The identity the verdicts evaluate under. */
  identity: StorageAuth | null;
  /** Pre-evaluated verdicts for `options.paths`, keyed by normalized path. */
  verdicts: Record<string, StorageGateVerdict>;
  /**
   * Evaluate an arbitrary path under the current ruleset + identity.
   * Pure and synchronous once `status` is `'ready'`; before that
   * (and whenever no rules are reachable) it returns the allow-all
   * verdict — the gate FAILS OPEN, because affordances are advisory
   * and the real enforcement (sandbox throw / server denial) stays
   * authoritative.
   */
  verdictFor: (path: string) => StorageGateVerdict;
  /** Rules-resolution failure (e.g. a malformed `rules` string). */
  error: Error | undefined;
}

/** Shared allow-all verdict — idle/loading/error and rules-less states. */
const ALLOW_ALL: StorageGateVerdict = Object.freeze({
  read: true,
  write: true,
  delete: true,
  upload: true,
  reasons: Object.freeze({
    read: [] as string[],
    write: [] as string[],
  }) as StorageGateVerdict['reasons'],
});

interface RulesState {
  status: StorageRulesGateStatus;
  rules: StorageRules | null;
  source: StorageRulesSource;
  error: Error | undefined;
}

/**
 * Pre-flight rules evaluation — the M7 differentiator. Evaluates the
 * current identity against paths BEFORE the click, so components can
 * annotate denied affordances (`data-pyric-denied`, disabled-with-
 * reason) instead of letting the user discover a denial via a thrown
 * `storage/unauthorized`.
 *
 * Rules discovery: a sandbox handle carries its deployed ruleset
 * (`getStorageSandbox(ctx, { rules })` parses it into the handle's
 * `StorageService`) — the hook reads it through the handle's target,
 * so sandbox callers pass nothing. Identity likewise defaults to the
 * handle's `SandboxContext.auth`. An explicit `rules` or `identity`
 * option overrides the handle when evaluating a what-if scenario.
 *
 * Evaluation contract (mirrors `pyric/storage`'s own enforcement):
 * `resource` (the existing object) is bound as `null` — the gate
 * pre-evaluates without fetching per-path metadata, matching how the
 * sandbox enforces `listAll`. Rules conditioned on existing-object
 * state (`resource.*`) evaluate as if the object doesn't exist; the
 * common identity/path/payload-shaped rules evaluate exactly.
 */
export function useStorageRulesGate(
  storage: FirebaseStorage | null | undefined,
  options: UseStorageRulesGateOptions = {},
): UseStorageRulesGateResult {
  const { paths, rules: rulesOption, identity: identityOption, writeResource } = options;

  const target = storage == null ? null : storage[TARGET_SYMBOL];

  const [state, setState] = useState<RulesState>(() => ({
    status: storage == null ? 'idle' : 'loading',
    rules: null,
    source: 'none',
    error: undefined,
  }));

  useEffect(() => {
    if (target == null) {
      setState({ status: 'idle', rules: null, source: 'none', error: undefined });
      return;
    }
    // Explicit option wins for what-if evaluation.
    if (rulesOption != null) {
      try {
        const parsed =
          typeof rulesOption === 'string' ? parseStorageRules(rulesOption) : rulesOption;
        setState({ status: 'ready', rules: parsed, source: 'option', error: undefined });
      } catch (e) {
        setState({
          status: 'error',
          rules: null,
          source: 'none',
          error: e instanceof Error ? e : new Error(String(e)),
        });
      }
      return;
    }
    let cancelled = false;
    setState({ status: 'loading', rules: null, source: 'none', error: undefined });
    target.servicePromise
      .then((service) => {
        if (cancelled) return;
        setState({
          status: 'ready',
          rules: service.rules,
          source: service.rules ? 'sandbox' : 'none',
          error: undefined,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({
          status: 'error',
          rules: null,
          source: 'none',
          error: e instanceof Error ? e : new Error(String(e)),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [target, rulesOption]);

  // `undefined` means "derive from the handle"; an explicit `null`
  // means anonymous.
  const identity: StorageAuth | null =
    identityOption !== undefined ? identityOption : (target?.context.auth ?? null);

  const { rules, status } = state;
  const writeSize = writeResource?.size;
  const writeContentType = writeResource?.contentType;

  const verdictFor = useCallback(
    (path: string): StorageGateVerdict => {
      if (rules == null) return ALLOW_ALL;
      const objectPath = normalizeStoragePath(path);
      const bucket = target?.bucket ?? 'pyric-default';
      const rulesPath = objectPath === '' ? `b/${bucket}/o` : `b/${bucket}/o/${objectPath}`;
      const evaluate = (method: StorageRequestMethod) =>
        evaluateStorageRules(rules, {
          request: {
            auth: identity,
            method,
            path: rulesPath,
            ...(method === 'create' && writeSize !== undefined
              ? { resource: { size: writeSize, contentType: writeContentType } }
              : {}),
          },
          resource: null,
        });
      const read = evaluate('read');
      const upload = evaluate('create');
      const deletion = evaluate('delete');
      const write = upload;
      return {
        read: read.allowed,
        write: write.allowed,
        delete: deletion.allowed,
        upload: upload.allowed,
        reasons: {
          read: read.allowed ? [] : read.reasons,
          write: write.allowed ? [] : write.reasons,
        },
      };
    },
    [rules, target?.bucket, identity, writeSize, writeContentType],
  );

  const pathsKey = typeof paths === 'string' ? paths : (paths ?? []).join('\n');
  const verdicts = useMemo(() => {
    const list = typeof paths === 'string' ? [paths] : (paths ?? []);
    const out: Record<string, StorageGateVerdict> = {};
    for (const p of list) {
      out[normalizeStoragePath(p)] = verdictFor(p);
    }
    return out;
    // `pathsKey` stands in for the (possibly inline) array identity,
    // so a fresh-but-equal `paths` array doesn't churn the record.
  }, [pathsKey, verdictFor]);

  return {
    status,
    source: state.source,
    advisory: false,
    identity,
    verdicts,
    verdictFor,
    error: state.error,
  };
}
