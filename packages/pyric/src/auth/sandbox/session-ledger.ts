/**
 * When each session last authenticated, the instant a revocation is compared
 * with (#1950).
 *
 * A revocation refuses every session authenticated before it, so this is per
 * session: the session that changes its own password keeps refreshing while
 * the account's other sessions (other browsers, other worker ports) are refused.
 * Every `User` built for one session (a remint, a restored copy) shares one
 * record, so a change one of them makes holds for all of them.
 *
 * Each record has a key, the sandbox's stand-in for a refresh token: a page
 * stores it with the uid, and a reload that hands it back resumes the session
 * with the time it had, instead of the uid's last sign-in.
 */
import type { User } from '../types.js';

interface SessionRecord {
  readonly key: string;
  readonly uid: string;
  authenticatedAtMs: number;
}

const recordsByUser = new WeakMap<User, SessionRecord>();
let issued = 0;

/** The key of the session `user` belongs to, or undefined for a `User` outside any session. */
export function sessionKeyOf(user: User): string | undefined {
  return recordsByUser.get(user)?.key;
}

/** One backend's sessions. `byUid` is the backend's last authentication of each uid. */
export class SessionLedger {
  private readonly byKey = new Map<string, SessionRecord>();

  constructor(private readonly byUid: ReadonlyMap<string, number>) {}

  /** `user` authenticated at `atMs`: a new session, or its own session again (a reauthentication, a password change it made). */
  authenticate(user: User, atMs: number): void {
    const record = recordsByUser.get(user);
    if (record !== undefined) record.authenticatedAtMs = atMs;
    else this.open(user, atMs);
  }

  /** When `user`'s session last authenticated, or the uid's last authentication for a `User` outside any session. */
  authenticatedAt(user: User): number | undefined {
    return recordsByUser.get(user)?.authenticatedAtMs ?? this.byUid.get(user.uid);
  }

  /** `user` continues `from`'s session. */
  continue(user: User, from: User): void {
    const record = recordsByUser.get(from) ?? this.adopt(from);
    if (record !== undefined) recordsByUser.set(user, record);
  }

  /** Put `user` in a session of its own, at the uid's last authentication, unless it is in one. */
  adopt(user: User): SessionRecord | undefined {
    const existing = recordsByUser.get(user);
    if (existing !== undefined) return existing;
    const at = this.byUid.get(user.uid);
    return at === undefined ? undefined : this.open(user, at);
  }

  /** `user` resumes the session `key` names. False when no session of `user`'s uid has that key. */
  resume(user: User, key: string): boolean {
    const record = this.byKey.get(key);
    const matches = record !== undefined && record.uid === user.uid;
    if (matches) recordsByUser.set(user, record);
    return matches;
  }

  private open(user: User, atMs: number): SessionRecord {
    issued += 1;
    const key = `session-${issued.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const record: SessionRecord = { key, uid: user.uid, authenticatedAtMs: atMs };
    this.byKey.set(key, record);
    recordsByUser.set(user, record);
    return record;
  }
}
