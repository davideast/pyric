/**
 * Response-header policy for routes that serve untrusted or user-supplied bytes
 * under the dev server's `/__pyric/` namespace (Storage byte route and avatar
 * asset route).
 *
 * Every response receives `Content-Security-Policy: sandbox; default-src 'none'`
 * and `X-Content-Type-Options: nosniff` so navigated documents run in an opaque
 * origin with scripts disabled and non-active types cannot be sniffed into HTML
 * or SVG. Active document MIME types (`text/html`, `application/xhtml+xml`,
 * `image/svg+xml`, XML/XSLT/MathML/MHTML, and script types) additionally force
 * `Content-Disposition: attachment` so direct top-level navigation downloads
 * instead of rendering inline, while `<img>`, media, and `fetch()` subresource
 * reads continue working unchanged.
 */

const UNTRUSTED_CONTENT_CSP = "sandbox; default-src 'none'";
export const UNTRUSTED_CONTENT_TYPE_OPTIONS = 'nosniff';

const ACTIVE_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/xsl',
  'application/xslt+xml',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/mathml',
  'application/mathml+xml',
  'multipart/related',
  'message/rfc822',
  'application/x-shockwave-flash',
  'text/cache-manifest',
]);

const ATTACHMENT_DISPOSITION_PATTERN = /^attachment(?:\s*;|$)/i;

function hasHeaderControlChars(value: string): boolean {
  return value.includes('\r') || value.includes('\n');
}

function mimeEssenceOf(segment: string): string {
  const semiIndex = segment.indexOf(';');
  const rawEssence = semiIndex >= 0 ? segment.slice(0, semiIndex) : segment;
  return rawEssence.trim().toLowerCase();
}

function isActiveMimeEssence(essence: string): boolean {
  if (essence.length === 0) {
    return false;
  }
  if (ACTIVE_MIME_TYPES.has(essence)) {
    return true;
  }
  if (essence.endsWith('+xml') || essence.endsWith('+html')) {
    return true;
  }
  return false;
}

function isActiveContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }
  if (hasHeaderControlChars(contentType)) {
    return true;
  }
  // Per WHATWG MIME Sniffing section 4.3, browsers resolve comma-separated
  // Content-Type headers to the last valid MIME type, so check every segment.
  for (const segment of contentType.split(',')) {
    if (isActiveMimeEssence(mimeEssenceOf(segment))) {
      return true;
    }
  }
  return false;
}

function isAttachmentDisposition(value: string): boolean {
  if (hasHeaderControlChars(value)) {
    return false;
  }
  return ATTACHMENT_DISPOSITION_PATTERN.test(value);
}

function resolveSafeContentDisposition(
  contentType: string | undefined,
  requestedDisposition: string | undefined,
): string | undefined {
  if (!isActiveContentType(contentType)) {
    if (requestedDisposition === undefined || hasHeaderControlChars(requestedDisposition)) {
      return undefined;
    }
    return requestedDisposition;
  }
  if (requestedDisposition !== undefined) {
    const trimmed = requestedDisposition.trim();
    if (isAttachmentDisposition(trimmed)) {
      return trimmed;
    }
  }
  return 'attachment';
}

/**
 * Security headers for an untrusted byte response. Preserves safe caller
 * `content-disposition` values on non-active types and enforces `attachment`
 * on active MIME types regardless of requested inline disposition.
 */
export function untrustedContentHeaders(
  contentType: string | undefined,
  requestedDisposition?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-security-policy': UNTRUSTED_CONTENT_CSP,
    'x-content-type-options': UNTRUSTED_CONTENT_TYPE_OPTIONS,
  };
  const disposition = resolveSafeContentDisposition(contentType, requestedDisposition);
  if (disposition !== undefined) {
    headers['content-disposition'] = disposition;
  }
  return headers;
}
