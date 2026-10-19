/**
 * What becomes of a Realtime Database call a client's socket took when that
 * socket drops (ADR-0019 decision 7, amended for #1088 and #1107). The web
 * hosted client and the Node remote client share this table.
 *
 * It follows `@firebase/database` 1.1.3. On a drop the SDK clears the response
 * callbacks but keeps its outstanding writes and reads, and `restoreState_`
 * sends them again after it reconnects. An onDisconnect it already sent lives
 * only in those callbacks, so its promise never settles. A sent transaction is
 * cancelled and `runTransaction` rejects with `Error('disconnect')`. Every
 * other call fails once with `unavailable`.
 *
 * No imports: the Node remote client loads this without the worker client.
 */
export type DropFate = 'resend' | 'forget' | 'disconnect' | 'fail';

const RTDB_FATES: Readonly<Record<string, DropFate>> = {
  'rtdb.set': 'resend',
  'rtdb.setPriority': 'resend',
  'rtdb.setWithPriority': 'resend',
  'rtdb.update': 'resend',
  'rtdb.remove': 'resend',
  'rtdb.push': 'resend',
  'rtdb.get': 'resend',
  'rtdb.onDisconnectSet': 'forget',
  'rtdb.onDisconnectUpdate': 'forget',
  'rtdb.onDisconnectRemove': 'forget',
  'rtdb.onDisconnectCancel': 'forget',
  'rtdb.transactionCommit': 'disconnect',
};

/** The fate of a call to `method` in flight at a drop: `fail` for any method the table does not name. */
export function rtdbFateAtDrop(method: string): DropFate {
  const isNamed = Object.hasOwn(RTDB_FATES, method);
  if (!isNamed) return 'fail';
  return RTDB_FATES[method];
}
