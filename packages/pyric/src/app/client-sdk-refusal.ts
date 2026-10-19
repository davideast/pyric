/**
 * Client Firebase SDKs in a server process that `@pyric/cli/register`
 * activated against a remote sandbox host (#1082).
 *
 * Under `PYRIC_SANDBOX=remote`, `remote:<url>`, `1` or `true`, `firebase-admin`
 * reaches the host through the remote sandbox factory. The client mirrors
 * (`pyric/database`, `pyric/firestore`, `pyric/auth`, `pyric/storage`) have no
 * path to the host yet, and a process-local sandbox would be a private store
 * the host never sees. So the register adapter binds the app registry to no
 * sandbox at all: the first service call on an app fails with
 * `failed-precondition` and says what to do instead. `PYRIC_SANDBOX=local`
 * keeps the in-process sandbox.
 */
import { FirebaseError } from '../sandbox/internal/firebase-error.js';

const ISSUE_URL = 'https://github.com/davideast/pyric/issues/1082';

/** Whether `PYRIC_SANDBOX` selects a remote host, as `pyric-admin`'s ambient init reads it. */
export function isRemoteSandboxActivation(value: string | undefined): boolean {
  const setting = value?.trim() ?? '';
  const namesRemoteHost = setting === 'remote' || setting.startsWith('remote:');
  const isBooleanOn = setting === '1' || setting === 'true';
  return namesRemoteHost || isBooleanOn;
}

/** The error every client service call raises in a remotely activated process. */
export function clientSdkRefusal(setting: string): FirebaseError {
  return new FirebaseError(
    'failed-precondition',
    'pyric: client Firebase SDKs (firebase/database, firebase/firestore, firebase/auth, firebase/storage) ' +
      `do not reach the sandbox host from a server process yet (PYRIC_SANDBOX=${setting.trim()}). ` +
      `Use firebase-admin in server code. See ${ISSUE_URL}.`,
  );
}
