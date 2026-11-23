/**
 * Explicit CLI argument parser and email validator for the `auth-google-oauth`
 * human-witnessed capture rig (#1814).
 *
 * Refuses to start unless both `--gmail` and `--non-gmail` are passed
 * explicitly on the command line, ensuring the operator never runs against
 * implicit or defaulted accounts.
 */

const GMAIL_DOMAIN = 'gmail.com';
const GOOGLEMAIL_DOMAIN = 'googlemail.com';
const SIMPLE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AuthGoogleOAuthCliOptions {
  readonly gmailEmail: string;
  readonly nonGmailEmail: string;
  readonly port: number;
  readonly openBrowser: boolean;
}

export function normalizeEmailAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

function splitEmailParts(normalized: string): { local: string; domain: string } | null {
  if (!SIMPLE_EMAIL_PATTERN.test(normalized)) {
    return null;
  }
  const atIndex = normalized.indexOf('@');
  if (atIndex <= 0 || atIndex !== normalized.lastIndexOf('@')) {
    return null;
  }
  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  if (local.length === 0 || domain.length === 0) {
    return null;
  }
  return { local, domain };
}

function parsePortValue(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --port value '${raw}': expected an integer in 0..65535.`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid --port value '${raw}': expected an integer in 0..65535.`);
  }
  return port;
}

/**
 * Returns a human-readable list of missing required CLI flags (`--gmail`,
 * `--non-gmail`) before capture credentials are loaded, or `null` when both
 * flags are supplied.
 */
export function missingExplicitEmailFlags(argv: readonly string[]): string | null {
  let hasGmail = false;
  let hasNonGmail = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--gmail') {
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--') && next.trim() !== '') {
        hasGmail = true;
      }
      i += 1;
    } else if (arg.startsWith('--gmail=')) {
      if (arg.slice('--gmail='.length).trim() !== '') {
        hasGmail = true;
      }
    } else if (arg === '--non-gmail') {
      const next = argv[i + 1];
      if (typeof next === 'string' && !next.startsWith('--') && next.trim() !== '') {
        hasNonGmail = true;
      }
      i += 1;
    } else if (arg.startsWith('--non-gmail=')) {
      if (arg.slice('--non-gmail='.length).trim() !== '') {
        hasNonGmail = true;
      }
    }
  }

  const missing: string[] = [];
  if (!hasGmail) {
    missing.push('--gmail=<throwaway@gmail.com>');
  }
  if (!hasNonGmail) {
    missing.push('--non-gmail=<throwaway@custom-domain>');
  }
  if (missing.length === 0) {
    return null;
  }
  return missing.join(', ');
}

/**
 * Parses and validates CLI arguments after `--write` / `--capture` have been
 * stripped by `requireCaptureMode`.
 */
export function parseAuthGoogleOAuthCliArgs(argv: readonly string[]): AuthGoogleOAuthCliOptions {
  let rawGmail: string | undefined;
  let rawNonGmail: string | undefined;
  let port = 0;
  let openBrowser = true;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--gmail') {
      const next = argv[i + 1];
      if (typeof next !== 'string' || next.startsWith('--')) {
        throw new Error('Missing value after --gmail (expected --gmail=<throwaway@gmail.com>).');
      }
      rawGmail = next;
      i += 1;
    } else if (arg.startsWith('--gmail=')) {
      rawGmail = arg.slice('--gmail='.length);
    } else if (arg === '--non-gmail') {
      const next = argv[i + 1];
      if (typeof next !== 'string' || next.startsWith('--')) {
        throw new Error(
          'Missing value after --non-gmail (expected --non-gmail=<throwaway@custom-domain>).',
        );
      }
      rawNonGmail = next;
      i += 1;
    } else if (arg.startsWith('--non-gmail=')) {
      rawNonGmail = arg.slice('--non-gmail='.length);
    } else if (arg === '--port') {
      const next = argv[i + 1];
      if (typeof next !== 'string') {
        throw new Error('Missing value after --port.');
      }
      port = parsePortValue(next);
      i += 1;
    } else if (arg.startsWith('--port=')) {
      port = parsePortValue(arg.slice('--port='.length));
    } else if (arg === '--no-open') {
      openBrowser = false;
    } else {
      throw new Error(
        `Unknown flag '${arg}'. Expected --gmail=<addr>, --non-gmail=<addr>, optional --port=<n>, and optional --no-open.`,
      );
    }
  }

  if (!rawGmail || rawGmail.trim() === '') {
    throw new Error('Refusing to start: --gmail=<throwaway@gmail.com> must be passed explicitly.');
  }
  if (!rawNonGmail || rawNonGmail.trim() === '') {
    throw new Error(
      'Refusing to start: --non-gmail=<throwaway@custom-domain> must be passed explicitly.',
    );
  }

  const gmailEmail = normalizeEmailAddress(rawGmail);
  const nonGmailEmail = normalizeEmailAddress(rawNonGmail);

  const gmailParts = splitEmailParts(gmailEmail);
  if (!gmailParts || gmailParts.domain !== GMAIL_DOMAIN) {
    throw new Error(
      `Invalid --gmail address: expected a valid @${GMAIL_DOMAIN} address, got '${rawGmail.trim()}'.`,
    );
  }

  const nonGmailParts = splitEmailParts(nonGmailEmail);
  if (!nonGmailParts) {
    throw new Error(`Invalid --non-gmail address: '${rawNonGmail.trim()}' is not a valid email.`);
  }
  if (nonGmailParts.domain === GMAIL_DOMAIN || nonGmailParts.domain === GOOGLEMAIL_DOMAIN) {
    throw new Error(
      `Invalid --non-gmail address: expected a non-@gmail.com domain, got '@${nonGmailParts.domain}'.`,
    );
  }

  if (gmailEmail === nonGmailEmail) {
    throw new Error('Invalid arguments: --gmail and --non-gmail must be distinct addresses.');
  }

  return {
    gmailEmail,
    nonGmailEmail,
    port,
    openBrowser,
  };
}
