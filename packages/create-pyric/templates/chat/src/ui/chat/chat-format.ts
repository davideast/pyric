import type { UiUser } from './chat-types';

/** The initials shown in an avatar for a user, or for "You" when there is none. */
export const initials = (user: UiUser | null): string =>
  (user?.displayName ?? user?.email ?? 'You').split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();

/** A short local time for a conversation or message timestamp. */
export const formatTime = (date?: Date): string => date ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date) : '';
