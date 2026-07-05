import {
  useQueryBuilder,
  QUERY_OPS,
  MULTI_VALUE_OPS,
  type QueryOp,
  type UseQueryBuilderOptions,
  type UseQueryBuilderResult,
} from '../hooks/useQueryBuilder.js';

export interface QueryBuilderProps {
  /** Drives the hook used internally. Both the state and the
   *  composed Query are exposed via `onChange`. */
  initial?: UseQueryBuilderOptions['initial'];
  /** Fired on every state change with the latest builder API. The
   *  parent typically calls `builder.buildQuery(collection)` and
   *  feeds the result into `useDocumentList` / `useFirestoreCollection`. */
  onChange?: (builder: UseQueryBuilderResult) => void;
  className?: string;
}

/**
 * Default visible composition over `useQueryBuilder`. Renders the
 * condition list + orderBy + limit form. Headless — every node
 * carries `data-pyric-*` for styling.
 *
 * Values are JSON-parsed on input. `42`, `"text"`, `true`, `null`,
 * and `[1, 2, 3]` (for `in`/`not-in`/`array-contains-any`) all
 * work; raw strings that aren't JSON-parsable fall through as-is.
 * For non-JSON Firestore values (Timestamp, GeoPoint, Reference,
 * Bytes), consumers either use the hook directly with their own
 * value editors or swap the rendered component out.
 */
export function QueryBuilder({ initial, onChange, className }: QueryBuilderProps) {
  const builder = useQueryBuilder({ initial });

  // Pipe state changes back to the consumer. We don't memoize on
  // the builder object itself since the hook already memoizes
  // internally; calling onChange every render is cheap and matches
  // the `<DocumentEditor>` pattern.
  if (onChange) onChange(builder);

  return (
    <div className={className} data-pyric-ui="query-builder">
      <ul data-pyric-query-conditions>
        {builder.conditions.map((cond) => (
          <li key={cond.id} data-pyric-query-condition>
            <input
              type="text"
              value={cond.field}
              placeholder="field"
              onChange={(e) =>
                builder.updateCondition(cond.id, { field: e.target.value })
              }
              data-pyric-query-field
              aria-label="Field"
            />
            <select
              value={cond.op}
              onChange={(e) =>
                builder.updateCondition(cond.id, { op: e.target.value as QueryOp })
              }
              data-pyric-query-op
              aria-label="Operator"
            >
              {QUERY_OPS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={stringifyValue(cond.value)}
              placeholder={MULTI_VALUE_OPS.has(cond.op) ? '[1, 2]' : 'value'}
              onChange={(e) =>
                builder.updateCondition(cond.id, { value: parseValue(e.target.value) })
              }
              data-pyric-query-value
              aria-label="Value"
            />
            <button
              type="button"
              onClick={() => builder.removeCondition(cond.id)}
              data-pyric-query-remove
              aria-label="Remove condition"
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => builder.addCondition()}
        data-pyric-query-add-condition
      >
        + Add condition
      </button>

      <div data-pyric-query-modifiers>
        <label data-pyric-query-orderby>
          <span>orderBy</span>
          <input
            type="text"
            value={builder.orderBy?.field ?? ''}
            placeholder="field"
            onChange={(e) => {
              const field = e.target.value;
              if (!field) {
                builder.setOrderBy(undefined);
              } else {
                builder.setOrderBy({
                  field,
                  direction: builder.orderBy?.direction ?? 'asc',
                });
              }
            }}
            data-pyric-query-orderby-field
          />
          <select
            value={builder.orderBy?.direction ?? 'asc'}
            onChange={(e) => {
              if (!builder.orderBy?.field) return;
              builder.setOrderBy({
                field: builder.orderBy.field,
                direction: e.target.value as 'asc' | 'desc',
              });
            }}
            disabled={!builder.orderBy?.field}
            data-pyric-query-orderby-direction
          >
            <option value="asc">asc</option>
            <option value="desc">desc</option>
          </select>
        </label>
        <label data-pyric-query-limit>
          <span>limit</span>
          <input
            type="number"
            min={0}
            value={builder.limit ?? ''}
            placeholder="∞"
            onChange={(e) => {
              const v = e.target.value;
              if (!v) {
                builder.setLimit(undefined);
              } else {
                const n = parseInt(v, 10);
                builder.setLimit(Number.isFinite(n) ? n : undefined);
              }
            }}
            data-pyric-query-limit-input
          />
        </label>
      </div>
    </div>
  );
}

function parseValue(raw: string): unknown {
  if (raw === '') return '';
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON — return the raw string. Firestore `where` will
    // refuse mistyped values at query time; the builder doesn't
    // gate on type because some workflows (e.g. searching by a
    // numeric-string id) are deliberate.
    return raw;
  }
}

function stringifyValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
