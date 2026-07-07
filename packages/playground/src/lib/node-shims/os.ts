/** Browser shim — see node-shims/path for context. */
export function homedir(): string {
  return '';
}
export function tmpdir(): string {
  return '/tmp';
}
export function platform(): string {
  return 'browser';
}
const os = { homedir, tmpdir, platform };
export default os;
