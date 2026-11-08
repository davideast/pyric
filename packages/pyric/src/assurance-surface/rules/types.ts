/**
 * Owner conditions read from security rules, and owner bindings that
 * cross-check them with the client's access sites.
 */
import type { AccessService } from '../code/types.js';

/** How an authorization decision is tied to the signed-in user. */
export type OwnerKind = 'pathVar' | 'storedField' | 'incomingField' | 'lookup';

/**
 * How the tied value relates to the uid: equal to it, starting with it
 * (`$key.beginsWith(auth.uid)`), containing it (`auth.uid in members`), or
 * a record that must exist under it (`root.child('members').child(auth.uid).exists()`).
 */
export type OwnerRelation = 'equals' | 'prefix' | 'contains' | 'exists';

/** One place a rule ties access to `auth.uid`. */
export interface OwnerCondition {
  service: AccessService;
  /** Rule path template: RTDB `$var`, Firestore `{var}` and `{var=**}`; no leading slash. */
  path: string;
  /** Operations the condition guards: RTDB `read`/`write`/`validate`, Firestore `get`/`list`/`create`/`update`/`delete`. */
  ops: string[];
  kind: OwnerKind;
  /**
   * What is tied: the path variable (`$uid`, `{userId}`); a field path
   * relative to the rule node (`author`, `../speaker/uid`, `.` for the
   * node's own value); or a lookup path (`rooms/$roomId/members/{auth.uid}`,
   * optionally `#field` for a Firestore `get(...).data.field`).
   */
  field: string;
  /** For pathVar: the variable's segment index in `path`. */
  varIndex?: number;
  /**
   * For stored and incoming fields: the field as an absolute location,
   * `path` segments joined with the field (RTDB) or `path#field` (Firestore).
   */
  location?: string;
  relation: OwnerRelation;
  /** True when the condition is required (on an all-`&&` route from the rule's root), false under `||`, `!` or a ternary. */
  required: boolean;
  /** Where the rule is: `file:line` (Firestore) or `file#/rules/a/$b/.write` (RTDB). */
  source: string;
  /** The comparison as written, printed back. */
  expression: string;
}

/** Which side supports a binding. */
export type OwnerEvidence = 'rules+code' | 'rules-only' | 'code-only';

/** An owner binding, the `ownerBindings` entry of `surface-report.json`. */
export interface OwnerBinding {
  /** Template using `{var}` for Firestore and `$var` for RTDB. */
  path: string;
  kind: OwnerKind;
  field: string;
  strength: 'strong' | 'tentative';
  service: AccessService;
  evidence: OwnerEvidence;
  relation?: OwnerRelation;
  /** Operations the rules guard with it (rules-backed bindings). */
  ops?: string[];
  required?: boolean;
  /**
   * Where ownership is decided versus where the client writes: a rule at
   * `devices/$uid` over writes at `devices/$uid/$device`
   * is a map keyed by owner.
   */
  depth: { decidedAt: string; writtenAt: string[]; keyedMap: boolean };
  ruleSources?: string[];
  codeSources?: string[];
  /** Short text of the rule comparison or the code evidence. */
  evidenceText: string;
}
