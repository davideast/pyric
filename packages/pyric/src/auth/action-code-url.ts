/**
 * `ActionCodeURL` / `parseActionCodeURL` — the out-of-band action link
 * parser.
 *
 * ─── The one piece of the email family that is FULLY observable ─────
 * Everything else in the email-link / action-code family has an
 * unobservable step in the middle: a message lands in an inbox a program
 * cannot read. This does not. Parsing an action link is a PURE,
 * CLIENT-SIDE, network-free function from a string to a set of fields —
 * the same computation in prod and in the sandbox, with no project, no
 * server, and no mailbox anywhere in it.
 *
 * So this file is not a sandbox approximation of production. It is the
 * same contract, and it is oracle-pinned:
 * `observations/auth/auth-actioncodeurl-parse.json` captured
 * firebase-js-sdk 12.13.0 parsing the links below, and the auth
 * oracle-conformance suite replays that capture against THIS code. The
 * facts it pinned:
 *
 *   - the `mode` query param maps to a NORMALIZED operation name, it is
 *     not passed through: `mode=resetPassword` -> `'PASSWORD_RESET'`,
 *     `mode=signIn` -> `'EMAIL_SIGNIN'`;
 *   - `oobCode` surfaces as `code`, `lang` as `languageCode`;
 *   - `continueUrl` is URL-DECODED on the way out;
 *   - a link missing `mode`, missing `oobCode`, or that is not a URL at
 *     all parses to `null` — the parse NEVER throws.
 */

import { ActionCodeOperation } from './enums.js';

/**
 * The `mode` query param -> `ActionCodeOperation` map. Oracle-pinned:
 * two of these five mappings (`resetPassword`, `signIn`) are asserted
 * directly against the capture; the rest follow the same normalization
 * upstream applies (`core/action_code_url.ts`).
 */
const MODE_TO_OPERATION: Record<string, string> = {
  recoverEmail: ActionCodeOperation.RECOVER_EMAIL,
  resetPassword: ActionCodeOperation.PASSWORD_RESET,
  signIn: ActionCodeOperation.EMAIL_SIGNIN,
  verifyEmail: ActionCodeOperation.VERIFY_EMAIL,
  verifyAndChangeEmail: ActionCodeOperation.VERIFY_AND_CHANGE_EMAIL,
  revertSecondFactorAddition: ActionCodeOperation.REVERT_SECOND_FACTOR_ADDITION,
};

/**
 * A parsed out-of-band action link. Mirrors `firebase/auth`'s
 * `ActionCodeURL`.
 *
 * Construct one only via {@link ActionCodeURL.parseLink} or
 * {@link parseActionCodeURL} — upstream's constructor is internal, and
 * both entry points return `null` rather than throwing for a link that
 * does not carry the required `mode` + `oobCode`.
 */
export class ActionCodeURL {
  /** The out-of-band code — the bearer token the action-code consumers
   *  (`applyActionCode`, `confirmPasswordReset`, …) redeem. */
  readonly code: string;
  /** The normalized operation the code authorizes. One of
   *  {@link ActionCodeOperation} — NOT the raw `mode` param. */
  readonly operation: string;
  /** The project API key carried in the link, or `null`. */
  readonly apiKey: string;
  /** Where to send the user after the action completes. URL-decoded.
   *  `null` when the link carried no `continueUrl`. */
  readonly continueUrl: string | null;
  /** BCP-47 language tag from the link's `lang` param, or `null`. */
  readonly languageCode: string | null;
  /** Multi-tenant tenant id, or `null`. The sandbox does not model
   *  tenants, so this is always `null` on a sandbox-minted link — but a
   *  link produced elsewhere and parsed here round-trips it. */
  readonly tenantId: string | null;

  private constructor(fields: {
    code: string;
    operation: string;
    apiKey: string;
    continueUrl: string | null;
    languageCode: string | null;
    tenantId: string | null;
  }) {
    this.code = fields.code;
    this.operation = fields.operation;
    this.apiKey = fields.apiKey;
    this.continueUrl = fields.continueUrl;
    this.languageCode = fields.languageCode;
    this.tenantId = fields.tenantId;
  }

  /**
   * Parse an action link. Returns `null` — never throws — when the input
   * is not a URL, carries no `mode`, carries an unrecognized `mode`, or
   * carries no `oobCode`. Oracle-pinned (see the file docstring).
   */
  static parseLink(link: string): ActionCodeURL | null {
    let url: URL;
    try {
      url = new URL(link);
    } catch {
      // Not a URL at all. Upstream returns null rather than throwing.
      return null;
    }
    const params = url.searchParams;
    const mode = params.get('mode');
    const code = params.get('oobCode');
    // Both are load-bearing: `mode` says what the code authorizes, and
    // without `oobCode` there is nothing to redeem. Either missing (or a
    // mode we do not recognize) => not an action link.
    if (!mode || !code) return null;
    const operation = MODE_TO_OPERATION[mode];
    if (!operation) return null;
    return new ActionCodeURL({
      code,
      operation,
      apiKey: params.get('apiKey') ?? '',
      // URLSearchParams.get already percent-decodes, so `continueUrl`
      // comes out as the real URL the sender encoded.
      continueUrl: params.get('continueUrl'),
      languageCode: params.get('lang'),
      tenantId: params.get('tenantId'),
    });
  }
}

/**
 * `parseActionCodeURL(link)` — free-function mirror of
 * {@link ActionCodeURL.parseLink}. Upstream ships both and they agree;
 * the oracle capture asserts that agreement
 * (`parseActionCodeURLAgrees: true`).
 */
export function parseActionCodeURL(link: string): ActionCodeURL | null {
  return ActionCodeURL.parseLink(link);
}
