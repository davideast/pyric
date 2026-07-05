import { useMemo, type ReactNode } from 'react';
import { truncateVectorsForDisplay } from '../../firestore/index.js';

/**
 * One field-level change in a staged proposal. A UI-level diff row: the host
 * adapts its backend diff (e.g. the sandbox's `Divergence[]`) into these so the
 * component stays decoupled from any backend type.
 */
export interface FieldChange {
  /** Full document path, e.g. `notes/abc123`. */
  docPath: string;
  /** The field that changed. */
  field: string;
  before: unknown;
  after: unknown;
  /** `added` = new field, `removed` = cleared, `changed` = value differs. */
  kind: 'added' | 'changed' | 'removed';
}

/**
 * An auth user a staged proposal creates (a sign-in account, distinct from
 * Firestore documents). The host adapts its backend request (e.g. a
 * `CreateUserRequest`) into this UI-level shape.
 */
export interface CreatedAuthUser {
  uid: string;
  email?: string;
  displayName?: string;
  provider?: string;
  emailVerified?: boolean;
}

export interface ProposedChangeDiffProps {
  changes: FieldChange[];
  /** Auth users the proposal creates, shown as a leading "auth users" group. */
  authUsers?: readonly CreatedAuthUser[];
  className?: string;
  /** Rendered when there are no changes. Defaults to nothing. */
  emptyState?: ReactNode;
  /** Format a value for display. Default: JSON-ish, empty for `undefined`. */
  formatValue?: (value: unknown) => ReactNode;
}

interface DocGroup {
  docPath: string;
  docId: string;
  fields: FieldChange[];
}
interface CollectionGroup {
  collection: string;
  docs: DocGroup[];
}

function groupChanges(changes: FieldChange[]): CollectionGroup[] {
  const byCollection = new Map<string, Map<string, FieldChange[]>>();
  for (const change of changes) {
    const slash = change.docPath.lastIndexOf('/');
    const collection = slash > 0 ? change.docPath.slice(0, slash) : change.docPath;
    let docs = byCollection.get(collection);
    if (!docs) {
      docs = new Map();
      byCollection.set(collection, docs);
    }
    let fields = docs.get(change.docPath);
    if (!fields) {
      fields = [];
      docs.set(change.docPath, fields);
    }
    fields.push(change);
  }
  return [...byCollection.entries()].map(([collection, docs]) => ({
    collection,
    docs: [...docs.entries()].map(([docPath, fields]) => ({
      docPath,
      docId: docPath.slice(docPath.lastIndexOf('/') + 1),
      fields,
    })),
  }));
}

/** A one-line account summary: "alice@x.dev · Alice · verified". */
function formatAuthUser(u: CreatedAuthUser): string {
  const parts = [u.email, u.displayName, u.provider, u.emailVerified ? 'verified' : null].filter(
    Boolean,
  );
  return parts.length ? (parts as string[]).join(' · ') : 'new account';
}

function defaultFormatValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    // Truncate vectors so a real embedding never dumps its full array here.
    return JSON.stringify(truncateVectorsForDisplay(value));
  } catch {
    return String(value);
  }
}

/**
 * Headless renderer for a staged change: the documents a proposal touches, with
 * per-field before/after. Grouped by collection. Ships zero styling; the host
 * styles the `data-pyric-*` contract (`proposed-change-diff` /
 * `data-pyric-change-*`). The c-review diff grid is this, styled.
 */
export function ProposedChangeDiff({
  changes,
  authUsers = [],
  className,
  emptyState = null,
  formatValue = defaultFormatValue,
}: ProposedChangeDiffProps) {
  const groups = useMemo(() => groupChanges(changes), [changes]);
  if (groups.length === 0 && authUsers.length === 0) return <>{emptyState}</>;

  return (
    <div className={className} data-pyric-ui="proposed-change-diff">
      {authUsers.length > 0 ? (
        <section data-pyric-change-group data-pyric-change-authgroup data-pyric-change-collection="auth users">
          <header data-pyric-change-grouphead>
            <span data-pyric-change-collname>auth users</span>
            <span data-pyric-change-count>{authUsers.length}</span>
          </header>
          <ul data-pyric-change-docs>
            {authUsers.map((user) => (
              <li key={user.uid} data-pyric-change-doc data-pyric-change-authuser>
                <span data-pyric-change-docid>{user.uid}</span>
                <span data-pyric-change-authmeta>{formatAuthUser(user)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {groups.map((group) => (
        <section
          key={group.collection}
          data-pyric-change-group
          data-pyric-change-collection={group.collection}
        >
          <header data-pyric-change-grouphead>
            <span data-pyric-change-collname>{group.collection}</span>
            <span data-pyric-change-count>{group.docs.length}</span>
          </header>
          <ul data-pyric-change-docs>
            {group.docs.map((doc) => (
              <li key={doc.docPath} data-pyric-change-doc>
                <span data-pyric-change-docid>{doc.docId}</span>
                <ul data-pyric-change-fields>
                  {doc.fields.map((field) => (
                    <li
                      key={field.field}
                      data-pyric-change-field
                      data-pyric-change-kind={field.kind}
                    >
                      <span data-pyric-change-key>{field.field}</span>
                      {field.kind !== 'added' ? (
                        <span data-pyric-change-before>{formatValue(field.before)}</span>
                      ) : null}
                      <span data-pyric-change-arrow aria-hidden>
                        {'→'}
                      </span>
                      {field.kind !== 'removed' ? (
                        <span data-pyric-change-after>{formatValue(field.after)}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
