/** The refusal a Node process's client SDK calls get when its host is not the Node host (#1082). */
import { FirebaseError } from 'pyric/app';

const ISSUE_URL = 'https://github.com/davideast/pyric/issues/1082';

/** The error every client SDK call gets when the host is not the Node host. */
export function offHostRefusal(detail: string): FirebaseError {
  return new FirebaseError(
    'failed-precondition',
    'pyric: client Firebase SDKs in a server process reach only the Node host ' +
      `(\`pyric sandbox --hosted\` or \`pyric({ hosted: true })\`), and ${detail}. ` +
      `Use firebase-admin in server code with the browser-hosted sandbox. See ${ISSUE_URL}.`,
  );
}
