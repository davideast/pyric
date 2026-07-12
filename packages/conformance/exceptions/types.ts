/**
 * Typed observation-exception data.
 *
 * `exceptions/` is the index: one authored `ObservationException` record per
 * excepted observation, named `<observation-name>.ts`. The filename IS the
 * key — the record carries no name field, matching the one-record-per-file
 * convention `surfaces/`, `rigs/`, and `observations/` already use.
 */
export interface ObservationException {
  /** Why this observation is allowed to exist without a citing registry row. */
  reason: string;
  /** Optional expiry note (a date, a milestone) for an exception that is meant
   *  to be temporary rather than permanent. Advisory only — not enforced. */
  until?: string;
}
