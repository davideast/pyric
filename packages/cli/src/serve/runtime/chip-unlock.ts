/**
 * Session-unlock link validation and runtime chip markup.
 *
 * Keeps remote-access unlock URL sanitization and chip action markup in one
 * module so `status.ts`, `worker-runtime.ts`, `chip.ts`, and `chip-live-view.ts`
 * share a single policy without expanding `chip.ts`.
 */
import { escapeAttribute, iconHtml, rowHtml, sectionHtml } from './chip-markup.js';

const UNLOCK_BASE_PATH = '/__pyric/unlock';
const MAX_UNLOCK_URL_LENGTH = 2048;
const FORBIDDEN_URL_CHARS_RE = /[\u0000-\u0020\u007f-\u009f#\\]/;

/**
 * Validate a relative `/__pyric/unlock` URL for safe `<a href>` rendering.
 * Accepts only `/__pyric/unlock` or `/__pyric/unlock?<query>` with no
 * fragments, control characters, whitespace, or cross-origin components.
 */
export function sanitizeUnlockUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_UNLOCK_URL_LENGTH) return null;
  if (FORBIDDEN_URL_CHARS_RE.test(trimmed)) return null;
  const isExactBase = trimmed === UNLOCK_BASE_PATH;
  const isQueryForm = trimmed.startsWith(`${UNLOCK_BASE_PATH}?`);
  if (!isExactBase && !isQueryForm) return null;
  try {
    const parsed = new URL(trimmed, 'http://localhost');
    if (parsed.origin !== 'http://localhost') return null;
    if (parsed.pathname !== UNLOCK_BASE_PATH) return null;
    if (parsed.hash.length > 0) return null;
    const rawNext = parsed.searchParams.get('next');
    if (rawNext !== null) {
      const isRelativeNext = rawNext.startsWith('/') && !rawNext.startsWith('//');
      if (!isRelativeNext) return null;
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

/**
 * Extract a validated `/__pyric/unlock` URL attached to an init refusal error
 * (or its wrapped `cause` chain).
 */
export function extractUnlockUrl(error: unknown): string | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== 'object' || current === null) return null;
    if (seen.has(current)) return null;
    seen.add(current);
    const record = current as { unlockUrl?: unknown; cause?: unknown };
    const validated = sanitizeUnlockUrl(record.unlockUrl);
    if (validated !== null) return validated;
    current = record.cause;
  }
  return null;
}

/** Primary Unlock link placed in the panel header when session pairing is required. */
export function unlockSessionHeaderLinkHtml(unlockUrl: string): string {
  const safeUrl = sanitizeUnlockUrl(unlockUrl);
  if (safeUrl === null) return '';
  return `<a class="btn btn-primary" data-unlock-session="header" href="${escapeAttribute(safeUrl)}" title="Open Pyric session unlock">${iconHtml('password')}Unlock</a>`;
}

/** Actionable row placed in Runtime/Sandbox and Traffic when the browser must pair. */
export function unlockSessionRowHtml(unlockUrl: string): string {
  const safeUrl = sanitizeUnlockUrl(unlockUrl);
  if (safeUrl === null) return '';
  const slot = `<a class="btn btn-primary" data-unlock-session="row" href="${escapeAttribute(safeUrl)}" title="Open Pyric session unlock">${iconHtml('password')}Unlock</a>`;
  return rowHtml({
    c1: 'Session locked',
    s1: 'Pair this browser with the server per-boot token.',
    slot,
    className: 'pending',
    attributes: 'data-unlock-required-row',
  });
}

/** Standalone section wrapping the unlock row for Traffic and Live views. */
export function unlockSessionSectionHtml(unlockUrl: string): string {
  const row = unlockSessionRowHtml(unlockUrl);
  if (row === '') return '';
  return sectionHtml('Session unlock', `<div class="rows">${row}</div>`);
}
