import type { AuthState } from 'pyric/sandbox';
import type { ListenerOwner } from '../../sandbox/types/events.js';
import type { JsonValue } from './data-tree.js';
import type { Priority, QueryRow, QuerySpec } from './query.js';
import type { PriorityRecord } from './priority-state.js';

export interface ValueListenerSnapshot {
  val: JsonValue;
  exists: boolean;
  key: string | null;
  rows?: QueryRow[];
}

export interface ValueListener {
  id: string;
  auth: AuthState;
  cb: (snap: ValueListenerSnapshot) => void;
  path: string;
  cancelCallback?: (error: Error) => void;
  onCanceled?: () => void;
  query?: QuerySpec;
  lastWindow?: QueryRow[];
  lastValue?: JsonValue;
  lastPriorityState?: string;
  /** Attached through the admin SDK, which bypasses rules. */
  admin?: boolean;
  /** Owners recorded on this listener's `attach` event. */
  owners?: ListenerOwner[];
}

/** One child event. A removed child carries the priorities it had, since the tree no longer holds them. */
export interface ChildEventSnapshot {
  key: string;
  val: JsonValue;
  previousChildName: string | null;
  priorities?: PriorityRecord;
}

export interface ChildListener {
  id: string;
  auth: AuthState;
  event: 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';
  path: string;
  cb: (snap: ChildEventSnapshot) => void;
  cancelCallback?: (error: Error) => void;
  onCanceled?: () => void;
  spec?: QuerySpec;
  lastWindow?: QueryRow[];
  /** The priorities at and below `path` when `lastWindow` was taken. */
  lastPriorities?: PriorityRecord;
}

/** Each listened parent before a write: its children's values and own
 *  priorities, by key, and every priority at and below it. */
export type ChildParentSnapshot = Map<string, {
  children: Map<string, { val: JsonValue; priority: Priority }>;
  priorities: PriorityRecord;
}>;
