/**
 * Keep the sandbox's deployed rules in sync with `workspace.rules`.
 * Subscribes to the workspace store and re-deploys on every change.
 *
 * Without this hook the sandbox starts with `rulesSource = ''` — an
 * unparseable empty string — and every preview operation throws
 * `Failed to parse rules source` or yields `permission-denied` from
 * listeners. The Run button still works for the "deploy + execute
 * Sandbox code" flow; this hook just makes the editor live so the
 * preview works the moment the iframe mounts.
 *
 * Two cadences:
 *
 *   - First non-empty rules value (mount or session hydration) →
 *     deploy SYNCHRONOUSLY. The home → /playground handoff loads
 *     rules in one tick and starts firing user code on the next; a
 *     300ms debounce here would crash any `useEffect` that touches
 *     Firestore on mount with "Failed to parse rules source". An
 *     immediate first deploy guarantees rules are in place before
 *     React commits the preview's effects.
 *
 *   - Subsequent edits → 300ms debounce so we don't re-parse on
 *     every keystroke while the user is typing.
 *
 * Publishes results into `useRuntimeStore.lastDeploy` so the toolbar
 * chip + Output panel can display the current deploy state from a
 * single source of truth.
 */
import { useEffect, useRef } from 'react';
import { getRunner } from '~/lib/sandbox/runner';
import { useRuntimeStore } from '~/lib/store/runtime';
import { useWorkspaceStore } from '~/lib/store/workspace';

const DEBOUNCE_MS = 300;

export function useRulesAutoDeploy(): void {
  const rules = useWorkspaceStore((s) => s.rules);
  const setLastDeploy = useRuntimeStore((s) => s.setLastDeploy);
  /** True once the first non-empty rules value has been deployed.
   *  Survives re-renders so a debounce-eligible edit doesn't get
   *  promoted back to "first deploy". */
  const firstDeployedRef = useRef(false);

  useEffect(() => {
    // No rules authored yet — don't deploy (an empty string fails to
    // parse and would surface "deploy failed" on a pristine page).
    // Stays in the "no deploy yet" state until the user writes
    // something. Once non-empty, this effect re-runs.
    if (rules.trim().length === 0) {
      setLastDeploy(null);
      return;
    }

    const deploy = (): void => {
      const runner = getRunner();
      const result = runner.deployRules(rules);
      setLastDeploy({ ok: result.ok, messages: result.messages, at: Date.now() });
    };

    if (!firstDeployedRef.current) {
      // First non-empty rules — deploy synchronously so any preview
      // useEffect that fires this tick sees a parsed ruleset.
      firstDeployedRef.current = true;
      deploy();
      return;
    }

    const id = setTimeout(deploy, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [rules, setLastDeploy]);
}
