/**
 * Spec card — the app-spec access matrix as a teaching surface
 * (plans/app-spec.md §2: users learn Firestore security from
 * "orders: create → owner only, price must match menu", not from 27k
 * chars of TSX).
 *
 * Rides the existing `strategy_event` channel: the draft-then-validate
 * `validation_result` milestone carries a `spec` summary (title,
 * assumptions, matrix rows, custom-condition count) whenever a draft
 * landed with a valid spec. This component reads the LAST such payload
 * off the message's captured `phaseEvents`.
 *
 * Degradation contract (same as the stepper): no spec → render
 * NOTHING. ReAct turns, fallback turns, and historical messages show
 * no empty chrome. Fully deterministic — no model call, no store
 * access. A card, not a workbench.
 */
import { Fragment } from 'react';
import type { StrategyPhaseEvent } from '~/lib/store/chat';

/* ── Pure model ────────────────────────────────────────────────── */

export interface SpecCardData {
  title: string;
  assumptions: string[];
  matrix: Array<{ collection: string; op: string; grant: 'deny' | string[] }>;
  customConditions: number;
  derivedCases: number;
}

/** Pull the latest spec summary off the turn's phase events. Defensive:
 *  events are stored raw (`Record<string, unknown>`), so every field is
 *  shape-checked; malformed payloads return null (→ no card). */
export function extractSpecCardData(
  phaseEvents?: readonly StrategyPhaseEvent[],
): SpecCardData | null {
  for (let i = (phaseEvents?.length ?? 0) - 1; i >= 0; i--) {
    const p = phaseEvents![i]!;
    if (p.name !== 'validation_result') continue;
    const spec = (p.data as { spec?: unknown } | undefined)?.spec;
    if (!spec || typeof spec !== 'object') continue;
    const s = spec as Record<string, unknown>;
    if (typeof s.title !== 'string' || !Array.isArray(s.matrix)) continue;
    const matrix: SpecCardData['matrix'] = [];
    for (const row of s.matrix) {
      const r = row as { collection?: unknown; op?: unknown; grant?: unknown };
      if (typeof r.collection !== 'string' || typeof r.op !== 'string') continue;
      const grant =
        r.grant === 'deny'
          ? ('deny' as const)
          : Array.isArray(r.grant)
            ? r.grant.filter((g): g is string => typeof g === 'string')
            : null;
      if (grant === null) continue;
      matrix.push({ collection: r.collection, op: r.op, grant });
    }
    if (matrix.length === 0) continue;
    return {
      title: s.title,
      assumptions: Array.isArray(s.assumptions)
        ? s.assumptions.filter((a): a is string => typeof a === 'string')
        : [],
      matrix,
      customConditions: typeof s.customConditions === 'number' ? s.customConditions : 0,
      derivedCases: typeof s.derivedCases === 'number' ? s.derivedCases : 0,
    };
  }
  return null;
}

/* ── Rendering ─────────────────────────────────────────────────── */

const GREEN = '#a4d4a8';
const AMBER = '#e6c79c';

function GrantCell({ grant }: { grant: 'deny' | string[] }) {
  if (grant === 'deny') {
    return <span className="text-slate-gray/70 italic">deny</span>;
  }
  return <span className="text-soft-white/90">{grant.join(' · ')}</span>;
}

export function SpecCard({
  phaseEvents,
}: {
  phaseEvents?: readonly StrategyPhaseEvent[];
}) {
  const data = extractSpecCardData(phaseEvents);
  if (!data) return null;

  // Group matrix rows by collection so each collection renders one
  // block of five op rows.
  const byCollection = new Map<string, SpecCardData['matrix']>();
  for (const row of data.matrix) {
    const rows = byCollection.get(row.collection) ?? [];
    rows.push(row);
    byCollection.set(row.collection, rows);
  }

  return (
    <div
      data-teach="spec-card"
      className="mb-3 rounded-md border border-[#2a2a35] px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[12px] font-mono text-soft-white">
          <span className="uppercase tracking-wider text-slate-gray text-[10px] mr-2">spec</span>
          {data.title}
        </p>
        <span
          className="text-[10px] font-mono tabular-nums shrink-0"
          style={{ color: GREEN }}
          title="Rules-test cases the host derived from this access matrix (deny-by-default cases included)"
        >
          {data.derivedCases} derived checks
        </span>
      </div>

      {/* The matrix — collection × op × grant summary. */}
      <table className="mt-2.5 w-full text-[11px] font-mono border-collapse">
        <tbody>
          {[...byCollection.entries()].map(([collection, rows]) => (
            <Fragment key={collection}>
              {rows.map((row, i) => (
                <tr key={`${collection}-${row.op}`} className="align-baseline">
                  <td className="pr-3 py-0.5 text-soft-white whitespace-nowrap">
                    {i === 0 ? collection : ''}
                  </td>
                  <td className="pr-3 py-0.5 uppercase tracking-wider text-slate-gray whitespace-nowrap">
                    {row.op}
                  </td>
                  <td className="py-0.5 leading-relaxed break-words">
                    <GrantCell grant={row.grant} />
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* Assumptions as callouts — the model's stated interpretation
          of the prompt, the cheapest place to catch a wrong guess. */}
      {data.assumptions.length > 0 ? (
        <ul className="mt-2.5 space-y-1">
          {data.assumptions.map((a, i) => (
            <li key={i} className="text-[11px] text-slate-gray leading-relaxed pl-3 border-l border-[#2a2a35]">
              {a}
            </li>
          ))}
        </ul>
      ) : null}

      {/* Custom conditions = the unverified residue. */}
      {data.customConditions > 0 ? (
        <p className="mt-2 text-[10px] font-mono" style={{ color: AMBER }}>
          {data.customConditions} custom condition{data.customConditions === 1 ? '' : 's'} — not
          host-verified; covered only by the model&apos;s own tests
        </p>
      ) : null}
    </div>
  );
}
