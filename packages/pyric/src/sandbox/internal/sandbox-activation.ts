/**
 * The one reading of the `PYRIC_SANDBOX` activator.
 *
 * `pyric sandbox` writes `remote:<url>` into a child's environment; a user may
 * set `remote` (find the project's host through `.pyric/serve.json`), `1` or
 * `true` (the same), or `local` (an in-process sandbox, for tests in Node).
 * `pyric-admin`'s ambient `initializeApp()`, the Node register adapters, the
 * register beacon and the Next.js rewrite target all read it through here, so
 * they agree on what each value selects.
 */

export type PyricSandboxActivation =
  /** Unset or blank: nothing is activated. */
  | { mode: 'off' }
  /** `local`: an in-process sandbox in this process. */
  | { mode: 'local' }
  /** `remote`, `1`, `true` (no url: discover the host) or `remote:<url>`. */
  | { mode: 'remote'; url?: string }
  /** `remote:` with nothing after it. */
  | { mode: 'invalid'; reason: 'empty-url'; value: string }
  /** Any other value, kept so a caller can name it or read it another way. */
  | { mode: 'invalid'; reason: 'unrecognized'; value: string };

const REMOTE_PREFIX = 'remote:';
const DISCOVERING_VALUES = new Set(['remote', '1', 'true']);

export function parsePyricSandbox(value: string | undefined): PyricSandboxActivation {
  const setting = value?.trim() ?? '';
  const isUnset = setting.length === 0;
  if (isUnset) return { mode: 'off' };
  if (setting === 'local') return { mode: 'local' };
  if (DISCOVERING_VALUES.has(setting)) return { mode: 'remote' };
  const namesUrl = setting.startsWith(REMOTE_PREFIX);
  if (!namesUrl) return { mode: 'invalid', reason: 'unrecognized', value: setting };
  const url = setting.slice(REMOTE_PREFIX.length).trim();
  const isEmptyUrl = url.length === 0;
  if (isEmptyUrl) return { mode: 'invalid', reason: 'empty-url', value: setting };
  return { mode: 'remote', url };
}

/** Whether the activator selects a remote host (with or without a url). */
export function isRemoteActivation(value: string | undefined): boolean {
  return parsePyricSandbox(value).mode === 'remote';
}
