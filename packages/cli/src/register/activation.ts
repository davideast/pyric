/**
 * Whether `@pyric/cli/register` is active in this thread.
 *
 * `PYRIC_SANDBOX` asks for the register, but the variable says nothing about
 * whether it loaded: a `.env` file Next reads, a `NODE_ENV=production`
 * refusal, or a package script that sets its own `NODE_OPTIONS` each leave the
 * variable set and the register absent (#1625). Code that depends on the
 * register reads this mark instead. It lives on `globalThis` under
 * `Symbol.for`, so it holds across two installed copies of `@pyric/cli`, and
 * importing this module never activates anything.
 */

/** Set by the register once its hooks, guard and factory global are in place. */
const REGISTER_ACTIVE = Symbol.for('pyric.register.active');

type MarkedGlobal = Record<symbol, unknown>;

/** Called by the register at the end of activation. */
export function markRegisterActive(): void {
  (globalThis as unknown as MarkedGlobal)[REGISTER_ACTIVE] = true;
}

/** Whether the register activated in this thread. */
export function isRegisterActive(): boolean {
  return (globalThis as unknown as MarkedGlobal)[REGISTER_ACTIVE] === true;
}

/**
 * Set by `@pyric/live/register` once its hooks are in place. Live mode is
 * not the register's sandbox: code that reads {@link isRegisterActive} to
 * learn that Firebase resolves to the sandbox never sees it.
 */
const LIVE_REGISTER_ACTIVE = Symbol.for('pyric.register.live.active');

/** Called by the live register at the end of activation. */
export function markLiveRegisterActive(): void {
  (globalThis as unknown as MarkedGlobal)[LIVE_REGISTER_ACTIVE] = true;
}

/** Whether `@pyric/live/register` activated in this thread. */
export function isLiveRegisterActive(): boolean {
  return (globalThis as unknown as MarkedGlobal)[LIVE_REGISTER_ACTIVE] === true;
}
