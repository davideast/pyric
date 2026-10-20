/**
 * Client Firebase services in a server process that `@pyric/cli/register`
 * activated against a remote sandbox host (#1082).
 *
 * Under `PYRIC_SANDBOX=remote`, `remote:<url>`, `1` or `true`, the register
 * mapping sends `firebase/database`, `firebase/firestore`, `firebase/auth`
 * and `firebase/storage` to `@pyric/cli`'s Node client, which reaches the Node
 * host. Every other client service resolved from such an app (`firebase/ai`,
 * `firebase/messaging`), and the in-process register adapter itself, refuse:
 * a process-local sandbox would be a private store the host never sees. The
 * app registry is bound to no sandbox at all, so the first such call fails
 * with `failed-precondition`. `PYRIC_SANDBOX=local` keeps the in-process
 * sandbox.
 */
import { FirebaseError } from '../sandbox/internal/firebase-error.js';
import { parsePyricSandbox } from '../sandbox/internal/sandbox-activation.js';

const ISSUE_URL = 'https://github.com/davideast/pyric/issues/1082';

/**
 * Whether `PYRIC_SANDBOX` names a remote host, including `remote:` with an
 * empty url, which `pyric-admin` refuses and no in-process sandbox may stand in for.
 */
export function isRemoteSandboxActivation(value: string | undefined): boolean {
  const activation = parsePyricSandbox(value);
  const isRemote = activation.mode === 'remote';
  const isEmptyRemoteUrl = activation.mode === 'invalid' && activation.reason === 'empty-url';
  return isRemote || isEmptyRemoteUrl;
}

/** The error a client service with no path to the host raises in a remotely activated process. */
export function clientSdkRefusal(setting: string): FirebaseError {
  return clientSdkRefusalFor(`PYRIC_SANDBOX=${setting.trim()}`);
}

/** The same refusal, for an activation named by `label` (an in-process activation names itself). */
export function clientSdkRefusalFor(label: string): FirebaseError {
  return new FirebaseError(
    'failed-precondition',
    `pyric: this client Firebase service does not reach the sandbox host from a server process (${label}). ` +
      'On the Node host, firebase/database, firebase/firestore, firebase/auth and firebase/storage do; ' +
      `use firebase-admin in server code for anything else. See ${ISSUE_URL}.`,
  );
}
