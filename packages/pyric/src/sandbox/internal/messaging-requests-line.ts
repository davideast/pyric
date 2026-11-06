/**
 * The one reading of a Messaging operation's requests that every traffic view
 * shares: the runtime chip's Traffic panel and Studio show a Messaging row's
 * target as the Installations and FCM registration requests its call made.
 */
import type { SandboxEvent } from '../types/events.js';
import type { ObservedRequest, ObservedRequestApi } from '../types/observed-call.js';

const API_LABELS: Record<ObservedRequestApi, string> = {
  installations: 'Installations',
  registrations: 'registrations',
};

const ACTION_LABELS: Record<ObservedRequest['action'], string> = {
  create: 'create',
  generateAuthToken: 'generate auth token',
  update: 'update',
  delete: 'delete',
};

function hasLabel<K extends string>(labels: Record<K, string>, key: unknown): key is K {
  return typeof key === 'string' && Object.hasOwn(labels, key);
}

/** One request as `<api> <action>, <status>`, with no status when the browser reported none. */
function requestText(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  const { api, action, status } = request as { api?: unknown; action?: unknown; status?: unknown };
  const isKnown = hasLabel(API_LABELS, api) && hasLabel(ACTION_LABELS, action);
  if (!isKnown) return undefined;
  const text = `${API_LABELS[api]} ${ACTION_LABELS[action]}`;
  return typeof status === 'number' ? `${text}, ${status}` : text;
}

/**
 * A Messaging operation's target: the requests its call made, such as
 * "Installations create, 200; registrations create, 403". `undefined` for any
 * other event, and for a Messaging call that lists none, so each view keeps
 * its own fallback.
 */
export function messagingRequestsLine(event: SandboxEvent): string | undefined {
  const isMessagingOperation = event.kind === 'operation' && event.service === 'messaging';
  if (!isMessagingOperation) return undefined;
  const requests = event.detail?.requests;
  if (!Array.isArray(requests)) return undefined;
  const texts = requests.flatMap((request) => requestText(request) ?? []);
  if (texts.length === 0) return undefined;
  const line = texts.join('; ');
  return line.charAt(0).toUpperCase() + line.slice(1);
}
