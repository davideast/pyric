/**
 * Agent mode control — compact persistent state for session-scoped
 * skills. Slash commands remain the quick activation path; this
 * control is the place to review, enable, disable, or reset skills
 * without turning the footer into a registry toolbar.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  listSkills,
  resolveActiveSkills,
  resolvePromptProfile,
  type AgentPromptProfile,
  type SkillDefinition,
} from '~/lib/skills/registry';
import { useSkillsStore } from '~/lib/store/skills';

export interface AgentModeSummary {
  icon: string;
  label: string;
  detail: string;
  activeCount: number;
  promptProfile: AgentPromptProfile;
}

function profileLabel(profile: AgentPromptProfile): string {
  return profile === 'firebase-tooling' ? 'Firebase tooling' : 'App builder';
}

export function summarizeAgentMode(activeSkills: readonly SkillDefinition[]): AgentModeSummary {
  const promptProfile = resolvePromptProfile(activeSkills);
  if (activeSkills.length === 0) {
    return {
      icon: 'auto_awesome',
      label: 'Default',
      detail: profileLabel(promptProfile),
      activeCount: 0,
      promptProfile,
    };
  }
  if (activeSkills.length === 1) {
    const skill = activeSkills[0]!;
    return {
      icon: skill.icon,
      label: skill.label,
      detail: profileLabel(promptProfile),
      activeCount: 1,
      promptProfile,
    };
  }
  return {
    icon: promptProfile === 'firebase-tooling' ? 'manage_search' : 'tune',
    label: profileLabel(promptProfile),
    detail: `${activeSkills.length} skills active`,
    activeCount: activeSkills.length,
    promptProfile,
  };
}

interface AgentModeControlProps {
  activeSkillIds: readonly string[];
  onToggleSkill: (id: string) => void;
  onClearSkills: () => void;
  className?: string;
}

export function AgentModeControl({
  activeSkillIds,
  onToggleSkill,
  onClearSkills,
  className = '',
}: AgentModeControlProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const panelId = useId();
  const skills = listSkills();
  const activeSkills = useMemo(
    () => resolveActiveSkills(activeSkillIds),
    [activeSkillIds],
  );
  const summary = useMemo(() => summarizeAgentMode(activeSkills), [activeSkills]);
  const activeSet = useMemo(() => new Set(activeSkillIds), [activeSkillIds]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleSkills = useMemo(() => {
    if (!normalizedQuery) return skills;
    return skills.filter((skill) => {
      const haystack = `${skill.id} ${skill.label} ${skill.description}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [normalizedQuery, skills]);
  const visibleActive = visibleSkills.filter((skill) => activeSet.has(skill.id));
  const visibleAvailable = visibleSkills.filter((skill) => !activeSet.has(skill.id));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (skills.length === 0) return null;

  const toggle = (id: string) => {
    onToggleSkill(id);
  };

  return (
    <div ref={rootRef} className={['relative min-w-0', className].filter(Boolean).join(' ')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={[
          'max-w-full inline-grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-full border px-2.5 py-1',
          'text-left transition-colors',
          summary.activeCount > 0
            ? 'border-[#a4d4a8]/60 bg-[#14201a] text-[#a4d4a8]'
            : 'border-[#2a2a35] bg-transparent text-slate-gray hover:text-soft-white hover:border-[#3a3a48]',
        ].join(' ')}
        title="Review agent mode and enabled skills"
      >
        <span className="material-symbols-outlined text-[14px]" aria-hidden>
          {summary.icon}
        </span>
        <span className="min-w-0 flex items-baseline gap-1.5">
          <span className="text-[9px] font-mono uppercase tracking-wider text-slate-gray/80 shrink-0">
            mode
          </span>
          <span className="min-w-0 truncate text-[11px] font-mono">{summary.label}</span>
          <span className="hidden sm:inline min-w-0 truncate text-[10px] text-slate-gray">
            {summary.detail}
          </span>
        </span>
        <span className="material-symbols-outlined text-[14px] text-slate-gray" aria-hidden>
          expand_more
        </span>
      </button>

      {open ? (
        <div
          id={panelId}
          className={[
            'fixed inset-x-3 bottom-3 z-50 max-h-[min(75vh,480px)] overflow-hidden rounded-md border border-[#2a2a35]',
            'bg-[#14141c] shadow-2xl',
            'sm:absolute sm:inset-auto sm:bottom-full sm:left-0 sm:mb-2 sm:w-[min(520px,calc(100vw-2rem))] sm:max-h-[420px]',
          ].join(' ')}
        >
          <div className="grid gap-3 border-b border-[#2a2a35] p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-mono uppercase tracking-wider text-slate-gray">
                  Agent mode
                </div>
                <div className="mt-1 flex items-center gap-2 text-[13px] font-semibold text-soft-white">
                  <span className="material-symbols-outlined text-[16px] text-[#a4d4a8]" aria-hidden>
                    {summary.icon}
                  </span>
                  <span className="min-w-0 truncate">{summary.label}</span>
                  <span className="text-[11px] font-normal text-slate-gray">{summary.detail}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-full p-1 text-slate-gray hover:text-soft-white hover:bg-[#20202c]"
                aria-label="Close agent mode"
              >
                <span className="material-symbols-outlined text-[16px]" aria-hidden>
                  close
                </span>
              </button>
            </div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full rounded-md border border-[#2a2a35] bg-content-bg px-2.5 py-1.5 text-[12px] text-soft-white placeholder:text-slate-gray/60 focus:outline-none focus:border-slate-gray"
              placeholder="Search skills"
              aria-label="Search skills"
            />
          </div>

          <div className="max-h-[min(58vh,320px)] overflow-y-auto custom-scrollbar p-2">
            {visibleSkills.length === 0 ? (
              <p className="px-2 py-4 text-[12px] text-slate-gray">No skills match.</p>
            ) : (
              <div className="grid gap-3">
                {visibleActive.length > 0 ? (
                  <SkillGroup
                    label="Active"
                    skills={visibleActive}
                    activeSet={activeSet}
                    onToggle={toggle}
                  />
                ) : null}
                {visibleAvailable.length > 0 ? (
                  <SkillGroup
                    label={visibleActive.length > 0 ? 'Available' : 'Skills'}
                    skills={visibleAvailable}
                    activeSet={activeSet}
                    onToggle={toggle}
                  />
                ) : null}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-[#2a2a35] p-2.5">
            <span className="text-[11px] text-slate-gray">Type / in the composer for quick activation.</span>
            <button
              type="button"
              onClick={onClearSkills}
              disabled={activeSkillIds.length === 0}
              className={[
                'shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider transition-colors',
                activeSkillIds.length > 0
                  ? 'border-[#2a2a35] text-slate-gray hover:text-soft-white hover:border-[#3a3a48]'
                  : 'border-[#2a2a35] text-slate-gray/40 cursor-not-allowed',
              ].join(' ')}
            >
              Reset
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface SkillGroupProps {
  label: string;
  skills: readonly SkillDefinition[];
  activeSet: Set<string>;
  onToggle: (id: string) => void;
}

function SkillGroup({ label, skills, activeSet, onToggle }: SkillGroupProps) {
  return (
    <section className="grid gap-1">
      <div className="px-2 text-[9px] font-mono uppercase tracking-wider text-slate-gray/70">
        {label}
      </div>
      {skills.map((skill) => {
        const active = activeSet.has(skill.id);
        return (
          <button
            key={skill.id}
            type="button"
            role="switch"
            aria-checked={active}
            onClick={() => onToggle(skill.id)}
            className={[
              'grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
              active ? 'bg-[#20202c]' : 'hover:bg-[#1a1a24]',
            ].join(' ')}
          >
            <span
              className={[
                'material-symbols-outlined text-[16px]',
                active ? 'text-[#a4d4a8]' : 'text-slate-gray',
              ].join(' ')}
              aria-hidden
            >
              {skill.icon}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[12px] font-mono text-soft-white">
                {skill.label}
              </span>
              <span className="block truncate text-[11px] text-slate-gray">
                {skill.description}
              </span>
            </span>
            <span
              className={[
                'inline-flex h-4 w-8 items-center rounded-full border transition-colors',
                active ? 'border-[#a4d4a8]/60 bg-[#a4d4a8]/30' : 'border-[#2a2a35] bg-content-bg',
              ].join(' ')}
              aria-hidden
            >
              <span
                className={[
                  'ml-0.5 h-3 w-3 rounded-full transition-transform',
                  active ? 'translate-x-3.5 bg-[#a4d4a8]' : 'translate-x-0 bg-slate-gray',
                ].join(' ')}
              />
            </span>
          </button>
        );
      })}
    </section>
  );
}

export function SessionAgentModeControl({ className = '' }: { className?: string }) {
  const activeSkillIds = useSkillsStore((state) => state.activeSkillIds);
  const toggleSkill = useSkillsStore((state) => state.toggleSkill);
  const clearSkills = useSkillsStore((state) => state.clear);
  return (
    <AgentModeControl
      activeSkillIds={activeSkillIds}
      onToggleSkill={toggleSkill}
      onClearSkills={clearSkills}
      className={className}
    />
  );
}
