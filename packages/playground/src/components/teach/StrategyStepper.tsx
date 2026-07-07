/**
 * Plan/phase stepper — the upfront "how did the agent run this turn"
 * strip above the activity timeline. One chip per strategy milestone
 * (draft → validate 3/4 → repair → validate 4/4), connected by thin
 * arrows so the turn reads as a story before the user scans tool rows.
 *
 * Renders NOTHING for plain ReAct turns (no milestones) — the plan's
 * graceful-degradation constraint. Warn/fail steps with prose detail
 * (critique feedback, escalation evidence) render the detail under
 * the chip row; ok/neutral details stay as hover titles.
 */
import type { ReflexionCritique, StrategyPhaseEvent } from '~/lib/store/chat';
import { buildStrategySteps, type StepTone } from './strategy-steps';

interface Props {
  phaseEvents?: readonly StrategyPhaseEvent[];
  critiques?: readonly ReflexionCritique[];
  streaming?: boolean;
}

const TONE_CLASSES: Record<StepTone, string> = {
  neutral: 'border-[#3a3a48] text-slate-gray',
  ok: 'border-emerald-400/40 text-emerald-400',
  warn: 'border-amber-400/40 text-amber-400',
  fail: 'border-rose-400/40 text-rose-400',
};

export function StrategyStepper({ phaseEvents, critiques, streaming = false }: Props) {
  const steps = buildStrategySteps(phaseEvents, critiques, streaming);
  if (steps.length === 0) return null;

  const detailed = steps.filter(
    (s) => s.detail && (s.tone === 'warn' || s.tone === 'fail'),
  );

  return (
    <div data-teach="strategy-stepper" className="flex flex-col gap-1.5">
      <ol className="flex flex-wrap items-center gap-y-1.5">
        {steps.map((s, i) => (
          <li key={s.id} className="flex items-center">
            {i > 0 ? (
              <span className="mx-1.5 text-[10px] text-slate-gray/50 select-none" aria-hidden>
                →
              </span>
            ) : null}
            <span
              className={[
                'inline-flex items-center rounded-full border px-2 py-0.5',
                'text-[10px] font-mono uppercase tracking-wider whitespace-nowrap',
                TONE_CLASSES[s.tone],
                streaming && s.id === 'running' ? 'animate-pulse' : '',
              ].join(' ')}
              {...(s.detail ? { title: s.detail } : {})}
            >
              {s.label}
            </span>
          </li>
        ))}
      </ol>
      {detailed.map((s) => (
        <p
          key={`detail-${s.id}`}
          className="text-[11px] text-slate-gray leading-relaxed break-words pl-1"
        >
          <span
            className={[
              'uppercase tracking-wider mr-1.5 text-[10px]',
              s.tone === 'fail' ? 'text-rose-400' : 'text-amber-400',
            ].join(' ')}
          >
            {s.label}:
          </span>
          {s.detail}
        </p>
      ))}
    </div>
  );
}
