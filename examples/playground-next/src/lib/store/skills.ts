/**
 * Active-skills store — which skills the user has toggled on for THIS
 * session. Session-scoped by design (a skill shapes a session's
 * intent — a game session vs a CRUD session), so state persists in
 * the session payload via `useSessionRouting` (like chat/telemetry),
 * NOT in localStorage settings.
 *
 * Consumers:
 *   - `SkillChips` (composer UI) — toggle + display
 *   - `buildSystemPrompt` / `buildClaudeLanePrompt` — inject briefs
 *   - agent-shell `man` — expose active skills' pages
 *   - tools listing — merge active skills' tool handlers
 */
import { create } from 'zustand';
import { skillById } from '~/lib/skills/registry';

interface SkillsState {
  /** Active skill ids, in activation order. Only known ids are kept. */
  activeSkillIds: string[];
  toggleSkill(id: string): void;
  /** Replace state from a loaded session payload (unknown ids dropped). */
  hydrate(ids: readonly string[] | null | undefined): void;
  clear(): void;
}

export const useSkillsStore = create<SkillsState>()((set) => ({
  activeSkillIds: [],
  toggleSkill: (id) =>
    set((s) => {
      if (!skillById(id)) return s;
      return s.activeSkillIds.includes(id)
        ? { activeSkillIds: s.activeSkillIds.filter((x) => x !== id) }
        : { activeSkillIds: [...s.activeSkillIds, id] };
    }),
  hydrate: (ids) =>
    set({
      activeSkillIds: Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === 'string' && !!skillById(id))
        : [],
    }),
  clear: () => set({ activeSkillIds: [] }),
}));
