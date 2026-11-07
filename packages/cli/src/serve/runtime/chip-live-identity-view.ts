/**
 * The chip's Identity tab on a live host: the production user the app's own
 * Auth holds (`live-identity.ts`), with Sign out, and the users signed in
 * during this page session. The sandbox's Rules, Switch user, search and
 * Create user stay out: production's users are not the sandbox's to list or
 * make.
 *
 * Signed in: the user's row with Sign out, then its UID and provider.
 * Signed out: a Signed out row. Recent users: each user the app signed in
 * this session other than the current one, newest first, or an empty state.
 */
import { buttonHtml, emptyHtml, escapeAttribute, iconHtml, rowHtml, sectionHtml, type ChipView } from './chip-markup.js';
import type { LiveIdentity } from './live-identity.js';

/** What the live Identity tab reads: the store's current user and its recent users. */
export interface LiveIdentityViewSource {
  current(): LiveIdentity | null;
  recent(): LiveIdentity[];
}

/** The live Identity tab's rules, drawn with the chip's existing tokens. */
export const LIVE_IDENTITY_STYLES = `
  [data-live-identity-view] { display: contents; }
  .row .s1.wrap { white-space: normal; overflow-wrap: anywhere; }
  .identity-facts > div { grid-template-columns: 64px minmax(0, 1fr); }
`;

/** The second line a provider names when the user has no email: a password or phone user. */
const PROVIDER_LINES: Readonly<Record<string, string>> = {
  password: 'Email and password',
  phone: 'Phone',
};

/** Two initials, as the sandbox's avatars draw them. */
function initialsOf(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase();
}

function providerHtml(providerId: string | null): string {
  if (providerId === null) return '';
  return `<span class="provider" role="img" aria-label="${escapeAttribute(providerId)}" title="${escapeAttribute(providerId)}">${iconHtml(providerId)}</span>`;
}

/** The avatar: a named user's initials, else the provider's mark for a phone user, else the user mark. */
function avatarHtml(user: LiveIdentity): string {
  const hasName = user.displayName !== null && user.displayName.trim() !== '';
  if (hasName) return `<span class="avatar"><span>${escapeAttribute(initialsOf(user.displayName!))}</span></span>`;
  return `<span class="avatar">${iconHtml(user.providerId === 'phone' ? 'phone' : 'user')}</span>`;
}

/** A user's two lines: the name over the email, or the email over its provider. */
function userLines(user: LiveIdentity): { title: string; detail: string } {
  const title = user.displayName ?? user.email ?? user.uid;
  const hasName = user.displayName !== null;
  const detail = hasName ? user.email ?? '' : PROVIDER_LINES[user.providerId ?? ''] ?? user.providerId ?? '';
  return { title, detail };
}

function signedInHtml(user: LiveIdentity): string {
  const { title, detail } = userLines(user);
  const row = rowHtml({
    c1: escapeAttribute(title),
    s1: escapeAttribute(detail),
    s1Right: providerHtml(user.providerId),
    leading: avatarHtml(user),
    slot: buttonHtml('data-live-sign-out', 'Sign out'),
    attributes: 'data-live-identity="signed-in"',
  });
  const provider = user.providerId === null ? '' : `<div><dt>Provider</dt><dd>${escapeAttribute(user.providerId)}</dd></div>`;
  const facts = `<div class="row"><dl class="sandbox-ai-facts identity-facts"><div><dt>UID</dt><dd>${escapeAttribute(user.uid)}</dd></div>${provider}</dl></div>`;
  return sectionHtml('Signed in', `<div class="rows">${row}${facts}</div>`, 'Production');
}

function signedOutHtml(): string {
  const row = rowHtml({
    c1: 'Signed out',
    s1: 'Sign in with your app, or pick a recent user.',
    slot: '',
    leading: `<span class="avatar">${iconHtml('user')}</span>`,
    attributes: 'data-live-identity="signed-out"',
  }).replace('class="s1 wide"', 'class="s1 wide wrap"');
  return sectionHtml('Current identity', `<div class="rows">${row}</div>`, 'Production');
}

function recentRowHtml(user: LiveIdentity): string {
  const { title, detail } = userLines(user);
  return rowHtml({
    c1: escapeAttribute(title),
    s1: escapeAttribute(detail),
    s1Right: providerHtml(user.providerId),
    leading: avatarHtml(user),
    slot: '',
    title: user.email ?? title,
    attributes: `data-live-recent-user="${escapeAttribute(user.uid)}"`,
  });
}

function recentHtml(users: readonly LiveIdentity[]): string {
  const hasUsers = users.length > 0;
  if (!hasUsers) return sectionHtml('Recent users', emptyHtml('No recent users', 'Users you sign in as on this machine appear here.'));
  return sectionHtml('Recent users', `<div class="rows">${users.map(recentRowHtml).join('')}</div>`, 'On this machine');
}

/** The live Identity tab: the production user or Signed out, then Recent users. No action bar. */
export function liveIdentityViewHtml(source: LiveIdentityViewSource): ChipView {
  const current = source.current();
  const recent = source.recent().filter((user) => user.uid !== current?.uid);
  const identity = current === null ? signedOutHtml() : signedInHtml(current);
  return { body: `<div data-live-identity-view>${identity}${recentHtml(recent)}</div>`, bar: '' };
}
