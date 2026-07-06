/**
 * Skill chips — session-scoped skill activation, rendered with the
 * composer. One chip per registered skill (lib/skills/registry.ts);
 * toggling persists via session autosave and takes effect on the next
 * submit (system-prompt brief + man page + gated tools).
 *
 * Renders NOTHING when the registry is empty — the framework is
 * invisible until a skill ships.
 */
import { listSkills } from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';

export function SkillChips() {
  const activeSkillIds = useSkillsStore((s) => s.activeSkillIds);
  const toggleSkill = useSkillsStore((s) => s.toggleSkill);
  const skills = listSkills();
  if (skills.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 px-3 py-1 flex-wrap">
      <span className="text-[9px] font-mono uppercase tracking-wider text-slate-gray/70 shrink-0">
        skills
      </span>
      {skills.map((skill) => {
        const active = activeSkillIds.includes(skill.id);
        return (
          <button
            key={skill.id}
            type="button"
            onClick={() => toggleSkill(skill.id)}
            title={skill.description}
            aria-pressed={active}
            className={[
              'flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-mono transition-colors',
              active
                ? 'border-[#a4d4a8]/60 bg-[#14201a] text-[#a4d4a8]'
                : 'border-[#2a2a35] bg-transparent text-slate-gray hover:text-soft-white hover:border-[#3a3a48]',
            ].join(' ')}
          >
            <span className="material-symbols-outlined text-[12px]" aria-hidden>
              {skill.icon}
            </span>
            {skill.label}
          </button>
        );
      })}
    </div>
  );
}
