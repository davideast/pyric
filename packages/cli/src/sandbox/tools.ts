/**
 * Whole-sandbox tool factory: composes Firestore and Auth into the same
 * document `pyric snapshot` promotes and `pyric sandbox --seed` re-serves
 * (`packages/cli/src/cli/snapshot.ts`, `packages/cli/src/serve/state-store.ts`).
 *
 * This lives in `@pyric/cli`, not `pyric/firestore` or `pyric/auth`, because
 * the operation spans two surfaces — the same reason `createRtdbInspectionTools`
 * (`packages/cli/src/rtdb/inspection.ts`) composes from the CLI side rather
 * than living inside one mirror surface (docs/code-conventions.md 8.5: tool
 * composition across surfaces lives in the tools/bridge layer, not inside a
 * surface; 8.2 keeps the surfaces' own `sandbox/` backends single-capability,
 * so a cross-surface composer cannot live there either). Imports only
 * browser-safe subpaths (`pyric/auth`, `pyric/sandbox`) so this factory can be
 * shared verbatim between the Node and browser sides of the bridge, mirroring
 * `rtdb/inspection.ts`.
 */
import type { ToolHandler } from '@inbrowser/agent';
import { getAuth, sandbox as authSandbox, type SeedUser } from 'pyric/auth';
import type { LocalSandbox } from 'pyric/sandbox';

export interface SandboxSnapshotToolDeps {
  /** Resolve the sandbox whose state should be promoted. */
  resolveSandbox(): Promise<LocalSandbox> | LocalSandbox;
}

/**
 * Sentinel written in place of a real password. Mirrors `NO_PASSWORD_SENTINEL`
 * (`pyric/auth`'s `sandbox-backend-types.ts`) and `pyric snapshot`'s own
 * `REDACTED_PASSWORD` (`packages/cli/src/cli/snapshot.ts`) — not re-exported
 * from `pyric/auth`, so defined locally the same way `snapshot.ts` does.
 */
const REDACTED_PASSWORD = '__pyric_no_password__';

/**
 * Inner controller-blob version this tool writes under `firestore.version`.
 * Mirrors `EXPECTED_CONTROLLER_BLOB_VERSION` in
 * `packages/cli/src/serve/state-store.ts` — duplicated rather than imported so
 * this browser-shared factory never pulls in that Node-only module (it reads
 * `.pyric/state/state.json` off disk). Bump in lockstep if that constant ever
 * moves.
 */
const CONTROLLER_BLOB_VERSION = 1;

/** Top-level envelope version. Mirrors `STATE_FILE_VERSION` in `state-store.ts`. */
const STATE_FILE_VERSION = 1;

function redactPassword(user: SeedUser, includePasswords: boolean): SeedUser {
  if (includePasswords || user.password === REDACTED_PASSWORD) return user;
  return { ...user, password: REDACTED_PASSWORD };
}

/**
 * `sandbox_snapshot` — promote the connected sandbox's live state to the same
 * envelope `pyric snapshot` writes: `{version, firestore: {version, firestore},
 * auth: {users}}`. The result is byte-for-byte loadable by
 * `pyric sandbox --seed`. Passwords are redacted by default (`includePasswords`
 * opts back in), matching `pyric snapshot`'s default.
 *
 * Firestore documents come from `sandbox.snapshot().firestore` — the same
 * cross-service snapshot `pyric/sandbox`'s persistence controller and
 * `pyric verify`'s replay already read. Auth users come from
 * `sandbox.exportUsers` (`pyric/auth`), the exact shape `sandbox.seedUsers`
 * accepts, so export -> seed round-trips.
 *
 * No Realtime Database section: the state-file format `pyric sandbox --seed`
 * accepts carries only `firestore` and `auth` today (`PyricStateFile` in
 * `state-store.ts`); RTDB has its own sandbox-side snapshot API
 * (`pyric/database`'s `sandbox.snapshotState`) but no slot in this envelope to
 * carry it, so it is omitted rather than invented here.
 */
export function createSandboxSnapshotTools(deps: SandboxSnapshotToolDeps): ToolHandler[] {
  const { resolveSandbox } = deps;
  return [
    {
      name: 'sandbox_snapshot',
      description:
        'Promote the connected sandbox\'s live state — Firestore documents and Auth users — to the same document `pyric snapshot` writes and `pyric sandbox --seed` re-serves. Passwords are redacted by default; pass `includePasswords:true` to keep them.',
      parameters: {
        type: 'object',
        properties: {
          includePasswords: {
            type: 'boolean',
            description: 'Keep real user passwords in the output instead of redacting them. Default false.',
            default: false,
          },
        },
      },
      async execute(args) {
        const a = args as { includePasswords?: boolean };
        const includePasswords = a.includePasswords ?? false;
        const sandbox = await resolveSandbox();
        const snap = sandbox.snapshot();
        const auth = getAuth(sandbox);
        const exported = authSandbox.exportUsers(auth);
        let redactedCount = 0;
        const users = exported.map((u) => {
          const redacted = redactPassword(u, includePasswords);
          if (redacted !== u) redactedCount++;
          return redacted;
        });
        const docCount = Object.keys(snap.firestore).length;
        const data = {
          version: STATE_FILE_VERSION,
          firestore: {
            version: CONTROLLER_BLOB_VERSION,
            firestore: snap.firestore,
          },
          auth: { users },
        };
        const summary =
          `${docCount} doc(s) + ${users.length} user(s)`
          + (redactedCount > 0 ? ` (${redactedCount} password(s) redacted)` : '');
        return { ok: true, summary, data };
      },
    },
  ];
}
