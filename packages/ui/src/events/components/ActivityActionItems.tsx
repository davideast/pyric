import type { ReactNode } from 'react';
import type { ActivityDigest, ActivityRow } from '../digest.js';

/** A single action item — a mechanical fact that invites a decision. */
export interface ActivityActionItem {
  /** Stable key. */
  key: string;
  /** What it is — drives `data-pyric-action-type`. Today: `denied`. */
  type: 'denied';
  /** The headline (mechanical: "4 writes to /notes were denied"). */
  title: string;
  /** Sub-line — attribution / cause. */
  meta?: string;
  /** The rows this item summarizes — for drill-in / linking into the
   *  matching Activity band (items LINK to bands, they don't duplicate). */
  rows: ActivityRow[];
}

export interface ActivityActionItemsProps {
  digest: ActivityDigest;
  /** Render the action button/affordance for an item (e.g. a "Debug"
   *  link). Returns `null` to render no action. */
  renderAction?: (item: ActivityActionItem) => ReactNode;
  /** Override item-title composition (host owns app-semantic copy). */
  renderTitle?: (item: ActivityActionItem) => ReactNode;
  className?: string;
  /** Rendered when there are no action items — default renders nothing
   *  (calm by default; the region collapses). */
  emptyState?: ReactNode;
}

/**
 * Group denial rows by collection prefix so the headline aggregates
 * ("4 writes to /notes were denied") rather than listing each row.
 */
function buildDenialItems(digest: ActivityDigest): ActivityActionItem[] {
  if (digest.denials.length === 0) return [];
  const byPrefix = new Map<string, ActivityRow[]>();
  for (const r of digest.denials) {
    // Collection prefix = everything up to the last segment.
    const i = r.target.lastIndexOf('/');
    const prefix = i === -1 ? r.target : r.target.slice(0, i);
    const key = prefix ? `/${prefix.replace(/^\/+/, '')}` : '(root)';
    const list = byPrefix.get(key);
    if (list) list.push(r);
    else byPrefix.set(key, [r]);
  }
  const items: ActivityActionItem[] = [];
  for (const [prefix, rows] of byPrefix) {
    const subjects = new Set(
      rows.map((r) => r.subjectUid).filter((u): u is string => !!u),
    );
    const n = rows.length;
    const noun = n === 1 ? 'write' : 'writes';
    const title = `${n} ${noun} to ${prefix} ${n === 1 ? 'was' : 'were'} denied`;
    const meta =
      subjects.size === 1
        ? `All by ${[...subjects][0]}.`
        : subjects.size > 1
          ? `By ${subjects.size} users.`
          : undefined;
    const item: ActivityActionItem = {
      key: `denied:${prefix}`,
      type: 'denied',
      title,
      rows,
    };
    if (meta) item.meta = meta;
    items.push(item);
  }
  // Most denials first.
  items.sort((a, b) => b.rows.length - a.rows.length);
  return items;
}

/**
 * The action-items tier — the few things wanting a decision, surfaced
 * ABOVE the activity grid (design-ideation Tier 2 / "Needs you").
 * Denials lead and are first-class. Mechanical copy by default; the host
 * supplies the action affordance (e.g. a "Debug" link into the rules
 * debugger) via `renderAction`.
 *
 * Data contract:
 * - `[data-pyric-ui="activity-action-items"]` — the root (absent when
 *   empty and no `emptyState`).
 * - `[data-pyric-action-item]` (+ `data-pyric-action-type`,
 *   `data-pyric-action-count`) — one item.
 * - `[data-pyric-action-title]` / `[data-pyric-action-meta]` — the copy.
 * - `[data-pyric-action-affordance]` — wraps the host's action node.
 */
export function ActivityActionItems({
  digest,
  renderAction,
  renderTitle,
  className,
  emptyState,
}: ActivityActionItemsProps): ReactNode {
  const items = buildDenialItems(digest);

  if (items.length === 0) {
    return emptyState ? (
      <div
        className={className}
        data-pyric-ui="activity-action-items"
        data-pyric-empty=""
      >
        {emptyState}
      </div>
    ) : null;
  }

  return (
    <div className={className} data-pyric-ui="activity-action-items">
      {items.map((item) => (
        <div
          key={item.key}
          data-pyric-action-item=""
          data-pyric-action-type={item.type}
          data-pyric-action-count={item.rows.length}
        >
          <div data-pyric-action-what="">
            <div data-pyric-action-title="">
              {renderTitle ? renderTitle(item) : item.title}
            </div>
            {item.meta ? (
              <div data-pyric-action-meta="">{item.meta}</div>
            ) : null}
          </div>
          {renderAction ? (
            <div data-pyric-action-affordance="">{renderAction(item)}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
