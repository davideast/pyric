import type { ReactNode } from 'react';
import type { AuthUserRecord } from 'pyric/auth';
import { VirtualList } from '../../primitives/VirtualList.js';
import { providerLabel } from '../providers.js';

export interface AuthUserListProps {
  /** Rows to render — usually `useAuthUsers().users`. */
  users: AuthUserRecord[];
  isLoading?: boolean;
  error?: Error;
  /** The active filter text. Distinguishes the "no users yet" zero state
   *  (empty filter) from "no results" (non-empty). */
  filter?: string;
  /** Fired when the identifier cell is clicked. When omitted, the
   *  identifier renders as plain text. */
  onSelect?: (user: AuthUserRecord) => void;
  /** Identifier-cell override. Default: email, else phone, else
   *  `anonymous`, else the uid. */
  renderIdentifier?: (user: AuthUserRecord) => ReactNode;
  /** Providers-cell override. Default: one `<span data-pyric-provider-id>`
   *  per linked provider with its text label (`anonymous` for anonymous
   *  users) — hook icons off the attribute. */
  renderProviders?: (user: AuthUserRecord) => ReactNode;
  /** Per-row selection control. Rendered in the leading cell so bulk
   *  selection stays visually separate from trailing row actions. */
  renderSelection?: (user: AuthUserRecord) => ReactNode;
  /** Optional content for the leading selection column header (for example,
   *  a select-all checkbox). Only rendered with `renderSelection`. */
  renderSelectionHeader?: ReactNode;
  /** Per-row action slot (edit / disable / delete menu). Rendered in a
   *  trailing cell; column header is added when this is provided. */
  renderActions?: (user: AuthUserRecord) => ReactNode;
  /** Optional content for the trailing actions column header (for example,
   *  a select-all checkbox). Only rendered with `renderActions`. */
  renderActionsHeader?: ReactNode;
  /** Timestamp formatter for Created / Signed In. Default: locale date,
   *  em dash for null. */
  formatDate?: (iso: string | null) => ReactNode;
  /** Zero state when the project has no users at all. */
  emptyState?: ReactNode;
  /** Zero state when the filter matches nothing. */
  noResultsState?: ReactNode;
  className?: string;
  /** Above this row count, rows render through `<VirtualList>`.
   *  Default 100. `Infinity` disables. */
  virtualizeThreshold?: number;
  /** Estimated row height when virtualizing. Default 44. */
  rowHeight?: number | ((index: number) => number);
  /** Scroll-container height when virtualized. Default `'60vh'`. */
  virtualizedHeight?: number | string;
}

function defaultIdentifier(user: AuthUserRecord): ReactNode {
  return user.email ?? user.phoneNumber ?? (user.isAnonymous ? 'anonymous' : user.uid);
}

function defaultProviders(user: AuthUserRecord): ReactNode {
  if (user.isAnonymous && user.providerUserInfo.length === 0) {
    return <span data-pyric-provider-id="anonymous">{providerLabel('anonymous')}</span>;
  }
  return user.providerUserInfo.map((p) => (
    <span key={p.providerId} data-pyric-provider-id={p.providerId}>
      {providerLabel(p.providerId)}
    </span>
  ));
}

function defaultFormatDate(iso: string | null): ReactNode {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
}

/**
 * Headless users table — the emulator UI's columns (Identifier,
 * Provider, Created, Signed In, User UID, actions) over the
 * `data-pyric-*` styling contract, with role-based table semantics so
 * rows can virtualize (a real `<table>` can't wrap a scroll container).
 *
 * The hook (`useAuthUsers`) owns data + filter state; this component
 * just renders. Disabled accounts carry `data-pyric-user-disabled` for
 * dimmed styling.
 */
export function AuthUserList({
  users,
  isLoading,
  error,
  filter,
  onSelect,
  renderIdentifier,
  renderProviders,
  renderSelection,
  renderSelectionHeader,
  renderActions,
  renderActionsHeader,
  formatDate = defaultFormatDate,
  emptyState,
  noResultsState,
  className,
  virtualizeThreshold = 100,
  rowHeight = 44,
  virtualizedHeight = '60vh',
}: AuthUserListProps) {
  if (error) {
    return (
      <div className={className} data-pyric-ui="auth-user-list" data-pyric-error="" role="alert">
        {error.message}
      </div>
    );
  }
  if (isLoading && users.length === 0) {
    return <div className={className} data-pyric-ui="auth-user-list" data-pyric-loading="" />;
  }
  if (users.length === 0) {
    const filtered = Boolean(filter?.trim());
    return (
      <div
        className={className}
        data-pyric-ui="auth-user-list"
        data-pyric-empty=""
        data-pyric-no-results={filtered ? '' : undefined}
      >
        {filtered
          ? (noResultsState ?? 'No results')
          : (emptyState ?? 'No users for this project yet')}
      </div>
    );
  }

  const virtualized = users.length > virtualizeThreshold;

  const row = (user: AuthUserRecord) => (
    <div
      key={user.uid}
      role="row"
      data-pyric-user-entry
      data-pyric-user-uid={user.uid}
      data-pyric-user-disabled={user.disabled ? '' : undefined}
    >
      {renderSelection ? (
        <span role="cell" data-pyric-user-cell="selection">
          {renderSelection(user)}
        </span>
      ) : null}
      <span role="cell" data-pyric-user-cell="identifier">
        {onSelect ? (
          <button type="button" data-pyric-user-select onClick={() => onSelect(user)}>
            {renderIdentifier ? renderIdentifier(user) : defaultIdentifier(user)}
          </button>
        ) : (
          (renderIdentifier ?? defaultIdentifier)(user)
        )}
      </span>
      <span role="cell" data-pyric-user-cell="providers">
        {(renderProviders ?? defaultProviders)(user)}
      </span>
      <span role="cell" data-pyric-user-cell="created">
        {formatDate(user.createdAt)}
      </span>
      <span role="cell" data-pyric-user-cell="signed-in">
        {formatDate(user.lastLoginAt)}
      </span>
      <span role="cell" data-pyric-user-cell="uid">
        {user.uid}
      </span>
      {renderActions ? (
        <span role="cell" data-pyric-user-cell="actions">
          {renderActions(user)}
        </span>
      ) : null}
    </div>
  );

  return (
    <div
      className={className}
      role="table"
      aria-label="Authentication users"
      data-pyric-ui="auth-user-list"
      data-pyric-virtualized={virtualized ? '' : undefined}
      data-pyric-selection={renderSelection ? '' : undefined}
      data-pyric-actions={renderActions ? '' : undefined}
    >
      <div role="row" data-pyric-user-header>
        {renderSelection ? (
          <span role="columnheader" data-pyric-user-cell="selection" aria-label="Selection">
            {renderSelectionHeader}
          </span>
        ) : null}
        <span role="columnheader" data-pyric-user-cell="identifier">Identifier</span>
        <span role="columnheader" data-pyric-user-cell="providers">Provider</span>
        <span role="columnheader" data-pyric-user-cell="created">Created</span>
        <span role="columnheader" data-pyric-user-cell="signed-in">Signed In</span>
        <span role="columnheader" data-pyric-user-cell="uid">User UID</span>
        {renderActions ? (
          <span role="columnheader" data-pyric-user-cell="actions" aria-label="Actions">
            {renderActionsHeader}
          </span>
        ) : null}
      </div>
      {virtualized ? (
        <VirtualList
          items={users}
          estimateSize={rowHeight}
          height={virtualizedHeight}
          getItemKey={(user) => user.uid}
          renderItem={row}
        />
      ) : (
        <div role="rowgroup" data-pyric-user-rows>
          {users.map(row)}
        </div>
      )}
    </div>
  );
}
