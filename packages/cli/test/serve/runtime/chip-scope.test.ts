import { describe, expect, it } from 'bun:test';
import type { LiveHostStatus } from 'pyric/sandbox/internal';
import {
  EVERY_CLIENT_SCOPE, inChipScope, liveSourceLabel, PAGE_SCOPE, scopeFromValue, scopeOptions, scopeSelectHtml, scopeValue,
  type ChipScope, type ChipScopeFields,
} from '../../../src/serve/runtime/chip-scope.js';
import { escapeAttribute } from '../../../src/serve/runtime/chip-markup.js';

type LiveClient = NonNullable<LiveHostStatus['clients']>[number];

const SELF = 'profile-self';
const CLIENTS: LiveClient[] = [
  { kind: 'node', clientId: 'journey-1', label: 'server.mjs', user: 'u1', lastSeen: 1 },
  { kind: 'browser', clientId: SELF, label: '/', user: 'u1', email: 'self@example.com', lastSeen: 1 },
  { kind: 'service-worker', clientId: 'sw-1', label: '/sw.js', user: null, lastSeen: 1 },
  { kind: 'browser', clientId: 'profile-b', label: '/dashboard', user: 'u2', email: 'b@example.com', lastSeen: 1 },
];

/** One call from each kind of caller: this page, another tab of its profile, profile B, a Node process, Studio, MCP, admin code. */
const CALLS: Record<string, ChipScopeFields> = {
  mine: { caller: { kind: 'page', pageId: 'tab-1', clientId: SELF }, auth: { uid: 'u1' } },
  tab: { caller: { kind: 'page', pageId: 'tab-2', clientId: SELF }, auth: { uid: 'u1' } },
  b: { caller: { kind: 'page', pageId: 'tab-b', clientId: 'profile-b' }, auth: { uid: 'u2' } },
  node: { caller: { kind: 'node', clientId: 'journey-1' }, auth: { uid: 'u1' } },
  worker: { caller: { kind: 'service-worker', clientId: 'sw-1' }, auth: null },
  studio: { caller: { kind: 'studio' } },
  mcp: { caller: { kind: 'mcp' } },
  admin: { caller: { kind: 'admin' }, auth: null },
  unstamped: {},
};

function keptBy(scope: ChipScope): string[] {
  return Object.entries(CALLS).filter(([, call]) => inChipScope(call, scope, 'tab-1')).map(([name]) => name).sort();
}

describe('the chip scope rule', () => {
  it('keeps exactly each scope\'s calls', () => {
    expect(keptBy(PAGE_SCOPE)).toEqual(['mine', 'unstamped']);
    expect(keptBy(EVERY_CLIENT_SCOPE)).toEqual(Object.keys(CALLS).sort());
    expect(keptBy({ kind: 'client', client: { kind: 'page', clientId: 'profile-b' } })).toEqual(['b']);
    expect(keptBy({ kind: 'client', client: { kind: 'node', clientId: 'journey-1' } })).toEqual(['node']);
    expect(keptBy({ kind: 'agents' })).toEqual(['admin', 'mcp', 'studio']);
    expect(keptBy({ kind: 'user', user: 'u1' })).toEqual(['mine', 'node', 'tab']);
    expect(keptBy({ kind: 'user', user: null })).toEqual(['admin', 'worker']);
  });

  it('round-trips every scope through an option value', () => {
    const scopes: ChipScope[] = [
      PAGE_SCOPE, EVERY_CLIENT_SCOPE, { kind: 'agents' }, { kind: 'user', user: null }, { kind: 'user', user: 'a:b' },
      { kind: 'client', client: { kind: 'page', clientId: 'id:with:colons' } },
    ];
    for (const scope of scopes) expect(scopeFromValue(scopeValue(scope))).toEqual(scope);
    expect(scopeFromValue('client:page')).toBeNull();
    expect(scopeFromValue('anything')).toBeNull();
  });

  it('offers every other client the host lists, then each uid seen, and never carries an email in a value', () => {
    const options = scopeOptions(CLIENTS, SELF, ['u3', 'u1']);
    // Kind order, as the Live tab lists them; this page's profile is not one of them.
    expect(options.clients.map((option) => option.value)).toEqual(['client:page:profile-b', 'client:service-worker:sw-1', 'client:node:journey-1', 'agents']);
    expect(options.users.map((option) => option.value)).toEqual(['user:u1', 'user:u2', 'user:u3', 'signed-out']);
    const values = [...options.clients, ...options.users].map((option) => option.value).join(' ');
    expect(values).not.toContain('@');
    const html = scopeSelectHtml('data-traffic-from', PAGE_SCOPE, options, null, escapeAttribute);
    expect([...html.matchAll(/value="([^"]*)"/g)].map((match) => match[1]).join(' ')).not.toContain('@');
  });

  it('keeps the chosen option of a client that is no longer listed, selected', () => {
    const gone = { kind: 'client', client: { kind: 'node', clientId: 'journey-9' } } as const;
    const chosen = { value: scopeValue(gone), label: 'chosen' };
    const html = scopeSelectHtml('data-traffic-from', gone, scopeOptions(CLIENTS, SELF, []), chosen, escapeAttribute);
    expect(html).toContain('<option value="client:node:journey-9" selected>');
  });

  it('names a row by the listed client that sent it, and by its source otherwise', () => {
    const source = (name: string, kind: Parameters<typeof liveSourceLabel>[1]) => liveSourceLabel(CALLS[name]!, kind, CLIENTS, SELF);
    expect(source('mine', 'page')).toBe(liveSourceLabel({}, 'page', [], SELF));
    expect(source('b', 'tab')).toContain('/dashboard');
    expect(source('node', 'node')).toContain('server.mjs');
    expect(source('studio', 'studio')).toBe(source('mcp', 'mcp'));
    // Another tab of this page's profile is not a listed client.
    expect(source('tab', 'tab')).toBe(liveSourceLabel({ caller: { kind: 'page', pageId: 'x' } }, 'tab', [], SELF));
  });
});
