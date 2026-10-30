/**
 * The head of one HTTP/1.1 request, as the model forwarder reads it from a
 * builder: the request line and the header fields. The parse is strict on
 * purpose. Anything it can't read is a malformed request the forwarder
 * refuses and records, never one it guesses at.
 */

export interface RequestHead {
  method: string;
  /** The request target as sent: `/v1/messages?beta=true`, an absolute URI, or a CONNECT authority. */
  target: string;
  /** Field names lowercased, in the order sent; a repeated field appears once per line. */
  headers: Array<[string, string]>;
}

const REQUEST_LINE = /^([A-Z]{1,16}) (\S{1,8192}) HTTP\/1\.[01]$/;
const FIELD = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*(.*?)[ \t]*$/;
const CONTROL_CHARACTER = /[\u0000-\u0008\u000a-\u001f\u007f]/;
const SHOWN_REQUEST_LINE = 300;

/** The head's request line and fields, or undefined when any line breaks HTTP/1.1's grammar. */
export function parseHead(text: string): RequestHead | undefined {
  const [requestLine = '', ...fields] = text.split('\r\n');
  const line = REQUEST_LINE.exec(requestLine);
  if (line === null || CONTROL_CHARACTER.test(requestLine)) return undefined;
  const headers: Array<[string, string]> = [];
  for (const field of fields) {
    const match = FIELD.exec(field);
    const value = match?.[2] ?? '';
    const isReadable = match !== null && !CONTROL_CHARACTER.test(value);
    if (!isReadable) return undefined;
    headers.push([(match[1] ?? '').toLowerCase(), value]);
  }
  return { method: line[1] ?? '', target: line[2] ?? '', headers };
}

export function headerValues(head: RequestHead, name: string): string[] {
  return head.headers.filter(([field]) => field === name).map(([, value]) => value);
}

/**
 * The first line of what a client sent, cut short and with anything
 * unprintable escaped, so a record line can show even a malformed request.
 */
export function shownRequestLine(raw: string): string {
  const first = raw.split(/\r?\n/)[0] ?? '';
  const printable = first.slice(0, SHOWN_REQUEST_LINE).replace(/[^ -~]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
  return first.length > SHOWN_REQUEST_LINE ? `${printable}…` : printable;
}

function hostOfAuthority(authority: string): string | undefined {
  try {
    return new URL(`http://${authority}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}

function hostOfUri(uri: string): string | undefined {
  try {
    return new URL(uri).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return undefined;
  }
}

/** `http://host/path` and the like, as opposed to the origin form `/path`. */
export const isAbsoluteUri = (target: string) => /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !target.startsWith('/');

/**
 * The host a request names: a CONNECT's authority, an absolute URI's host,
 * or the Host field. A client inside the sandbox can only reach the bridge,
 * so this is the host it meant to reach, which is what the record keeps.
 */
export function namedHost(head: RequestHead): string | undefined {
  if (head.method === 'CONNECT') return hostOfAuthority(head.target);
  if (isAbsoluteUri(head.target)) return hostOfUri(head.target);
  const host = headerValues(head, 'host')[0];
  return host === undefined ? undefined : hostOfAuthority(host);
}

const LINE_START = /^([A-Z]{1,16}) (\S+)/;

/**
 * The host the start of a head names when the whole head could not be read
 * (it broke off, ran too long, or broke the grammar later on), so a record
 * line can still say which host a request reached for.
 */
export function hostInHeadStart(raw: string): string | undefined {
  const start = LINE_START.exec(raw);
  if (start === null) return undefined;
  return namedHost({ method: start[1] ?? '', target: start[2] ?? '', headers: [] });
}

