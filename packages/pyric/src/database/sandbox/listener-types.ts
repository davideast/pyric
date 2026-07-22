import type { AuthState } from 'pyric/sandbox';
import type { JsonValue } from './data-tree.js';
import type { QueryRow, QuerySpec } from './query.js';

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
}

export interface ChildListener {
  id: string;
  auth: AuthState;
  event: 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';
  path: string;
  cb: (snap: { key: string; val: JsonValue; previousChildName: string | null }) => void;
  cancelCallback?: (error: Error) => void;
  onCanceled?: () => void;
  spec?: QuerySpec;
  lastWindow?: QueryRow[];
}

export type ChildParentSnapshot = Map<string, Map<string, JsonValue>>;
