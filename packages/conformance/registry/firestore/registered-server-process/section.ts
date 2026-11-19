import { defineRowSection } from '../../section-rows.ts';

export const section = defineRowSection({
  surface: 'firestore',
  order: 270,
  prefix: '### Client SDKs in a registered server process\n\nA server process started with `node --import @pyric/cli/register` and `PYRIC_SANDBOX=remote`, `remote:<url>`, `1` or `true` runs the client SDKs against the Node host (#1082): `firebase/app`, `firebase/database`, `firebase/firestore`, `firebase/auth` and `firebase/storage` resolve to `@pyric/cli`\'s Node client, which reaches the host over its own hosted connection with the process\'s own signed-in session, so the host\'s rules apply as they do for any other client. Off the Node host every call fails instead of running against a private in-process sandbox, and the client services with no path to the host refuse. `PYRIC_SANDBOX=local` keeps the in-process sandbox. In production the client SDKs run in Node and reach the project.\n',
  defaults: {
    section: "Client SDKs in a registered server process",
    status: "diverged-documented",
    automation: "unit-backed",
  },
});

export const row = section.row;
