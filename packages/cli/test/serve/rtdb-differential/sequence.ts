/**
 * The RTDB operation sequences the differential runner replays on every plane.
 *
 * A sequence is plain JSON so it can be saved as a fixture and replayed in any
 * process. Server values are written as markers (`{ "$ts": true }` and
 * `{ "$inc": n }`) and each plane turns them into its own SDK's sentinels.
 * Instances are numbered: 0 is the project's default instance, 1 and 2 are
 * named instances with their own URLs.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** A value as a sequence writes it: JSON, possibly holding server-value markers. */
export type WriteValue = JsonValue;

export interface QuerySpec {
  orderBy: 'key' | 'value' | 'priority' | { child: string };
  startAt?: { value: JsonValue; key?: string };
  startAfter?: { value: JsonValue; key?: string };
  endAt?: { value: JsonValue; key?: string };
  endBefore?: { value: JsonValue; key?: string };
  equalTo?: { value: JsonValue; key?: string };
  limitToFirst?: number;
  limitToLast?: number;
}

export type ListenEvent = 'value' | 'child_added' | 'child_changed' | 'child_removed' | 'child_moved';

/** The update function a transaction runs, by name; see the interpreter for each. */
export type TransactionScript = 'increment' | 'abort' | 'createOnly' | 'replaceObject' | 'delete' | 'contend';

export type Step =
  | { op: 'set'; db: number; path: string; value: WriteValue }
  | { op: 'update'; db: number; path: string; values: Record<string, WriteValue> }
  | { op: 'push'; db: number; path: string; value?: WriteValue }
  | { op: 'remove'; db: number; path: string }
  | { op: 'transaction'; db: number; path: string; script: TransactionScript; applyLocally?: boolean }
  | { op: 'setPriority'; db: number; path: string; priority: string | number | null }
  | { op: 'setWithPriority'; db: number; path: string; value: WriteValue; priority: string | number | null }
  | { op: 'onDisconnectSet'; db: number; path: string; value: WriteValue; priority?: string | number | null }
  | { op: 'onDisconnectUpdate'; db: number; path: string; values: Record<string, WriteValue> }
  | { op: 'onDisconnectRemove'; db: number; path: string }
  | { op: 'onDisconnectCancel'; db: number; path: string }
  /** `goOffline` then `goOnline`: the instance's queued onDisconnect writes run. */
  | { op: 'reconnect'; db: number }
  | { op: 'listen'; db: number; id: number; path: string; event: ListenEvent; query?: QuerySpec }
  | { op: 'unlisten'; id: number }
  | { op: 'get'; db: number; path: string; query?: QuerySpec }
  | { op: 'signIn'; uid: string; claims?: Record<string, JsonValue> }
  | { op: 'signInAnonymously' }
  | { op: 'signOut' }
  | { op: 'refreshToken' }
  | { op: 'rules'; db: number; rules: number };

export interface Sequence {
  seed: number;
  /** How many instances the sequence opens, 2 or 3. */
  instances: number;
  /** The rules pool index each instance starts with. */
  initialRules: number[];
  steps: Step[];
}

/** The project and instance URLs every plane opens. */
export const PROJECT_ID = 'diff-project';
export const INSTANCE_URLS: Array<string | undefined> = [
  undefined,
  'https://diff-second.firebaseio.com',
  'https://diff-third.europe-west1.firebasedatabase.app',
];
export const INSTANCE_NAMES: Array<string | undefined> = [undefined, 'diff-second', 'diff-third'];

/**
 * The rules pool. Each entry is valid for a production deploy, and together
 * they cover `$wildcards`, `auth` and custom claims, `.validate`, `newData`
 * and `data`, priority, and `.indexOn`.
 */
export const RULES_POOL: Array<{ rules: Record<string, unknown> }> = [
  { rules: { '.read': true, '.write': true } },
  { rules: { '.read': 'auth != null', '.write': 'auth != null' } },
  {
    rules: {
      '.read': true,
      users: {
        $uid: {
          '.write': 'auth != null && auth.uid === $uid',
          '.validate': 'newData.hasChildren() || newData.isString() || newData.isNumber() || newData.isBoolean()',
        },
      },
      items: {
        '.write': true,
        '.indexOn': ['n', '.value'],
        $item: { '.validate': "newData.isNumber() || newData.isString() || newData.hasChild('n')" },
      },
      counters: { $c: { '.write': true, '.validate': 'newData.isNumber()' } },
      rooms: { '.write': 'auth != null' },
      meta: { '.write': true },
    },
  },
  {
    rules: {
      '.read': "auth != null && auth.token.role == 'admin'",
      items: { '.read': true, '.write': "auth != null && (auth.token.role == 'editor' || auth.token.role == 'admin')" },
      users: { $uid: { '.read': 'auth.uid == $uid', '.write': 'auth.uid == $uid' } },
      counters: { '.read': true, '.write': 'auth.token.tier >= 2' },
      rooms: { '.read': true, '.write': true },
      meta: { '.read': true, '.write': "auth.token.role == 'admin'" },
    },
  },
  {
    rules: {
      '.read': true,
      items: { $k: { '.write': '!data.exists() || !newData.exists()' } },
      counters: { $c: { '.write': 'newData.isNumber() && (!data.exists() || newData.val() > data.val())' } },
      users: { '.write': true },
      rooms: { $r: { '.write': true, messages: { $m: { '.validate': "newData.child('t').isString()" } } } },
      meta: { '.write': "newData.child('stamp').val() <= now" },
    },
  },
  {
    rules: {
      '.read': true,
      '.write': true,
      items: { $k: { '.validate': 'newData.getPriority() == null || newData.getPriority() < 100' } },
      counters: { '.indexOn': '.value' },
    },
  },
  { rules: { '.read': false, '.write': false } },
  {
    rules: {
      '.read': true,
      '.write': 'auth != null',
      items: { '.indexOn': ['n'], $k: { n: { '.validate': 'newData.isNumber()' } } },
      users: { $uid: { '.write': 'auth.uid === $uid' } },
    },
  },
];
