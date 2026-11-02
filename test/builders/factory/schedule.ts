/**
 * Which seats the factory runs and when. The table is the schedule; `wanted`
 * reads it against the run's state and returns the seats that should start
 * now, in order, before the concurrency cap is applied.
 *
 * - The lead runs first, again after each round of reviews, and whenever a
 *   builder would start with nothing on the work list.
 * - The builders run continuously once the lead has run.
 * - The user agent, design reviewer and triage run when owed one session:
 *   after each hourly check, or when a builder marks work ready. Triage
 *   waits for the other two, since it sorts what they found.
 */
import type { SupervisorState } from './run-dir.ts';
import type { Role } from './session.ts';
import { hasWorkFor, type WorkItem } from './work-list.ts';

export type ReviewRole = SupervisorState['reviewsOwed'][number];

export interface Seat {
  seat: string;
  role: Role;
  mode: 'lead' | 'continuous' | 'on-demand';
  /** On-demand seats that must not be owed or running before this one starts. */
  after?: readonly ReviewRole[];
}

export const MAX_SESSIONS = 4;

export const SEATS: readonly Seat[] = [
  { seat: 'lead', role: 'lead', mode: 'lead' },
  { seat: 'builder-1', role: 'builder', mode: 'continuous' },
  { seat: 'builder-2', role: 'builder', mode: 'continuous' },
  { seat: 'user-agent', role: 'user-agent', mode: 'on-demand' },
  { seat: 'design-reviewer', role: 'design-reviewer', mode: 'on-demand' },
  { seat: 'triage', role: 'triage', mode: 'on-demand', after: ['user-agent', 'design-reviewer'] },
];

export const REVIEW_ROLES: readonly ReviewRole[] = ['user-agent', 'design-reviewer', 'triage'];

export const PROMPTS = {
  lead: 'Read the specs, the work list, the progress notes and the latest check. Order the work list, add what is missing, and note your decisions in the progress notes.',
  leadPlan: 'The work list has nothing a builder can take. Plan the next items, if any, and write them to the work list.',
  builder: 'Take a todo item from the work list (or go on with yours), set yourself as its owner, build it in the app, add a progress note, and mark it ready when it is built.',
  'user-agent': 'Use the app as its user would, through the items marked ready and the latest check. Write what you find to the progress notes.',
  'design-reviewer': 'Review the design of what is marked ready against the specs. Write what you find to the progress notes.',
  triage: 'Sort the latest findings in the progress notes into work list items, and mark reviewed items done.',
} as const;

export interface ScheduleView {
  state: SupervisorState;
  items: readonly WorkItem[];
  /** Seats with a session running now. */
  running: ReadonlySet<string>;
}

export interface Start {
  seat: Seat;
  prompt: string;
}

function isReviewRole(role: Role): role is ReviewRole {
  return (REVIEW_ROLES as readonly Role[]).includes(role);
}

function anyBuilderStarved(view: ScheduleView): boolean {
  return SEATS.some((seat) => {
    const isIdleBuilder = seat.mode === 'continuous' && !view.running.has(seat.seat);
    return isIdleBuilder && !hasWorkFor(view.items, seat.seat);
  });
}

function leadStart(seat: Seat, view: ScheduleView): Start | undefined {
  const starved = view.state.leadSessions > 0 && anyBuilderStarved(view);
  if (!view.state.leadOwed && !starved) return undefined;
  const hasNoWork = !SEATS.some((other) => other.mode === 'continuous' && hasWorkFor(view.items, other.seat));
  return { seat, prompt: hasNoWork ? PROMPTS.leadPlan : PROMPTS.lead };
}

function builderStart(seat: Seat, view: ScheduleView): Start | undefined {
  const leadHasRun = view.state.leadSessions > 0;
  if (!leadHasRun || !hasWorkFor(view.items, seat.seat)) return undefined;
  return { seat, prompt: PROMPTS.builder };
}

function reviewStart(seat: Seat, view: ScheduleView): Start | undefined {
  if (!isReviewRole(seat.role) || !view.state.reviewsOwed.includes(seat.role)) return undefined;
  const waiting = (seat.after ?? []).some((role) => view.state.reviewsOwed.includes(role) || view.running.has(role));
  if (waiting) return undefined;
  return { seat, prompt: PROMPTS[seat.role] };
}

const START_BY_MODE: Record<Seat['mode'], (seat: Seat, view: ScheduleView) => Start | undefined> = {
  lead: leadStart,
  continuous: builderStart,
  'on-demand': reviewStart,
};

/** The seats that should start now, in the table's order. */
export function wanted(view: ScheduleView): Start[] {
  const starts: Start[] = [];
  for (const seat of SEATS) {
    if (view.running.has(seat.seat)) continue;
    const start = START_BY_MODE[seat.mode](seat, view);
    if (start !== undefined) starts.push(start);
  }
  return starts;
}
