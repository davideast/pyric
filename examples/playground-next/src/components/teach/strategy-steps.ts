/**
 * Strategy-milestone model for the plan/phase stepper. Maps the raw
 * `strategy_event` milestones captured on an assistant message
 * (`phaseEvents` — draft-then-validate today, C2's escalation events
 * when they land) plus reflexion critiques into a flat ordered list
 * of steps the stepper renders.
 *
 * Degradation contract (the plan's binding constraint): a plain ReAct
 * turn has neither phase events nor critiques → this returns `[]` and
 * the stepper renders NOTHING. No empty chrome.
 *
 * Unknown event names (future strategies, C2's escalation milestone)
 * render generically: humanized label, warn tone when the name smells
 * like an escalation/exhaustion, neutral otherwise — so Track C can
 * ship new milestones without a Track D lockstep.
 */
import type { ReflexionCritique, StrategyPhaseEvent } from '~/lib/store/chat';

export type StepTone = 'neutral' | 'ok' | 'warn' | 'fail';

export interface StrategyStep {
  id: string;
  label: string;
  tone: StepTone;
  /** Secondary prose (e.g. a critique's feedback, an escalation's
   *  carried evidence). Rendered under the chip row for warn/fail. */
  detail?: string;
}

function num(d: Record<string, unknown>, k: string): number | undefined {
  return typeof d[k] === 'number' ? (d[k] as number) : undefined;
}

function str(d: Record<string, unknown>, k: string): string | undefined {
  return typeof d[k] === 'string' ? (d[k] as string) : undefined;
}

function humanize(name: string): string {
  return name.replace(/[_-]+/g, ' ').trim();
}

function stepForPhaseEvent(p: StrategyPhaseEvent, idx: number): StrategyStep {
  const d = (p.data ?? {}) as Record<string, unknown>;
  const id = `phase-${idx}`;
  switch (p.name) {
    case 'draft_started': {
      const attempt = num(d, 'attempt') ?? 0;
      return {
        id,
        tone: 'neutral',
        label: attempt === 0 ? 'draft' : `revision ${attempt}`,
      };
    }
    case 'validation_result': {
      if (d.skipped) {
        return {
          id,
          tone: 'neutral',
          label: 'validation skipped',
          detail: str(d, 'reason') ?? 'n/a',
        };
      }
      const passed = num(d, 'passed') ?? 0;
      const total = num(d, 'total') ?? 0;
      return {
        id,
        tone: passed === total ? 'ok' : 'warn',
        label: `validate ${passed}/${total}`,
      };
    }
    case 'repair_started': {
      const failures = num(d, 'failures') ?? 0;
      return {
        id,
        tone: 'warn',
        label: `repair · ${failures} failing`,
      };
    }
    case 'validation_exhausted': {
      const remaining = num(d, 'remaining') ?? 0;
      return {
        id,
        tone: 'fail',
        label: `${remaining} unresolved · retries spent`,
      };
    }
    default: {
      // Unknown milestone — render generically. Escalation-shaped
      // names (C2's re-submit under ReAct) read as a warning beat in
      // the story; anything else is a neutral milestone.
      const isEscalation = /escalat|exhaust|fallback/i.test(p.name);
      const detail = str(d, 'reason') ?? str(d, 'feedback') ?? str(d, 'note');
      return {
        id,
        tone: isEscalation ? 'warn' : 'neutral',
        label: humanize(p.name),
        ...(detail ? { detail } : {}),
      };
    }
  }
}

function stepForCritique(c: ReflexionCritique, idx: number): StrategyStep {
  const id = `critique-${idx}`;
  if (c.verdict === 'ok') {
    return { id, tone: 'ok', label: 'critique passed' };
  }
  if (c.verdict === 'retry') {
    return {
      id,
      tone: 'warn',
      label: 'critique → retry',
      ...(c.feedback ? { detail: c.feedback } : {}),
    };
  }
  return {
    id,
    tone: 'fail',
    label: 'critique → returned (retries spent)',
    ...(c.feedback ? { detail: c.feedback } : {}),
  };
}

export function buildStrategySteps(
  phaseEvents?: readonly StrategyPhaseEvent[],
  critiques?: readonly ReflexionCritique[],
  streaming = false,
): StrategyStep[] {
  const steps: StrategyStep[] = [];
  (phaseEvents ?? []).forEach((p, i) => steps.push(stepForPhaseEvent(p, i)));
  // Reflexion and draft-validate are mutually exclusive strategies, so
  // a simple concat preserves chronology in practice. If a future
  // strategy emits both, interleaving needs timestamps on the events.
  (critiques ?? []).forEach((c, i) => steps.push(stepForCritique(c, i)));
  if (streaming) {
    steps.push({ id: 'running', label: 'running', tone: 'neutral' });
  }
  return steps;
}
