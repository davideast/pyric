/**
 * `auth_impersonate`, `auth_reset`, `auth_whoami`, `auth_sessions` — the MCP
 * view of who the bridge's clients, and the bridge's own caller, act as.
 *
 * In-process: the client registry and the caller identity are bridge-process
 * state, never the browser peer's. The factory receives both through the
 * in-process tool context (`bridge/server/tool-family-factories.ts`); a
 * headless `pyric mcp` supplies neither, and the tools then report that no
 * bridge is running instead of throwing.
 *
 * One tool per operation, per `docs/decisions/0013-mcp-tool-names-carry-the-operation.md`:
 * the name is the whole path joined with underscores and there is no `op`
 * field.
 */

import type { ToolHandler } from '@inbrowser/agent';
import {
  SELF_SCOPE_NOTE,
  TARGET_SCOPE_NOTE,
  listSessions,
  parseImpersonation,
  readCallerIdentity,
  setCallerIdentity,
  setSessionIdentity,
  type CallerIdentityStore,
  type SessionRegistry,
} from './identity.js';

export interface AuthIdentityToolDeps {
  /** The bridge's client registry, absent when no bridge runs here. */
  sessions?: SessionRegistry;
  /** The bridge's caller identity, absent when no bridge runs here. */
  caller?: CallerIdentityStore;
}

const TARGET_SCHEMA = {
  type: 'string' as const,
  description:
    'Another client connected to this bridge, by the target id auth_sessions reports ' +
    '(pyric serve sessions lists the ids). Omit to act on yourself.',
};

const IMPERSONATE_DESCRIPTION = [
  'Act as a specific user. Supply exactly one of uid, admin: true, or anonymous: true.',
  'uid impersonates that user, with optional tenant (Identity Platform tenant id)',
  'and claims (custom claims, which rules read as request.auth.token.<name>).',
  'admin bypasses Security Rules. anonymous is signed out.',
  'With no target this records your own identity on the bridge.',
  SELF_SCOPE_NOTE,
  'With a target it retargets that connected client instead: the bridge stores the identity',
  'and notifies that client, which stamps it on the operations it then issues.',
  TARGET_SCOPE_NOTE,
].join(' ');

const RESET_DESCRIPTION = [
  'Stop acting as anyone and follow the application session again — the user the app is signed in as.',
  'With no target this resets your own identity on the bridge.',
  SELF_SCOPE_NOTE,
  'With a target it resets that connected client instead.',
  TARGET_SCOPE_NOTE,
].join(' ');

const WHOAMI_DESCRIPTION = [
  'Report the identity this bridge holds for you: admin, a uid with its tenant and claims,',
  'anonymous, or the application session.',
  SELF_SCOPE_NOTE,
  'Use auth_sessions for the identity of every other client connected to this bridge.',
].join(' ');

const SESSIONS_DESCRIPTION = [
  'List every client connected to this bridge — a mobile runtime, a Studio tab, a Node client —',
  'with its target id, platform, and the identity it currently acts as.',
  'Pass a target id to auth_impersonate or auth_reset to drive that client.',
].join(' ');

export function createAuthIdentityTools(deps: AuthIdentityToolDeps = {}): ToolHandler[] {
  return [
    {
      name: 'auth_impersonate',
      description: IMPERSONATE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          uid: { type: 'string', description: 'The user to act as.' },
          tenant: {
            type: 'string',
            description: 'Identity Platform tenant id carried on the impersonated token. Requires uid.',
          },
          claims: {
            type: 'object',
            description:
              'Custom claims carried on the impersonated token. Rules read them as request.auth.token.<name>. Requires uid.',
          },
          admin: { type: 'boolean', description: 'Act with Security Rules bypassed.' },
          anonymous: { type: 'boolean', description: 'Act signed out.' },
          target: TARGET_SCHEMA,
        },
      },
      async execute(rawArgs) {
        const args = asArgs(rawArgs);
        const parsed = parseImpersonation(args, 'auth_impersonate');
        if (!parsed.ok) return parsed.result;
        return args.target === undefined
          ? setCallerIdentity(deps.caller, parsed.identity)
          : setSessionIdentity(deps.sessions, args.target, parsed.identity, 'auth_impersonate');
      },
    },

    {
      name: 'auth_reset',
      description: RESET_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: { target: TARGET_SCHEMA },
      },
      async execute(rawArgs) {
        const args = asArgs(rawArgs);
        return args.target === undefined
          ? setCallerIdentity(deps.caller, { mode: 'app-session' })
          : setSessionIdentity(deps.sessions, args.target, { mode: 'app-session' }, 'auth_reset');
      },
    },

    {
      name: 'auth_whoami',
      description: WHOAMI_DESCRIPTION,
      parameters: { type: 'object', properties: {} },
      async execute() {
        return readCallerIdentity(deps.caller);
      },
    },

    {
      name: 'auth_sessions',
      description: SESSIONS_DESCRIPTION,
      parameters: { type: 'object', properties: {} },
      async execute() {
        return listSessions(deps.sessions);
      },
    },
  ];
}

function asArgs(rawArgs: unknown): Record<string, unknown> {
  return (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
    ? rawArgs
    : {}) as Record<string, unknown>;
}
