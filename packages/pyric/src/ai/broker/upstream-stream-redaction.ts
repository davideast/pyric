/**
 * Redaction for `2xx` upstream responses (SSE streams and non-streaming bodies).
 *
 * - `maskStreamErrors` buffers at most one SSE event (up to the next blank line
 *   or EOF) so single-line object errors (`data: {"error": ...}`), array-wrapped
 *   errors (`data: [{"error": ...}]`), multi-line JSON error events, and
 *   `event: error` frames are masked while complete non-error events flush
 *   immediately in linear time without cross-event buffering.
 * - `redactUpstreamSuccessBody` masks `2xx` non-streaming JSON error envelopes
 *   and (when enabled for server-authenticated routes such as the Gemini proxy)
 *   exact server-configured credentials echoed in non-error `2xx` payloads
 *   without running URL-pattern scrubbing on ordinary model answers (ADR 0024).
 */
import {
  CREDENTIAL_MASK,
  parseJson,
  quotedForms,
  redactUpstreamError,
} from './upstream-error-redaction.js';

const MIN_SUCCESS_CREDENTIAL_LENGTH = 8;

function isJsonErrorObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && 'error' in value;
}

/** Whether a parsed JSON value is an upstream error object or an array containing one. */
export function isJsonErrorEnvelope(value: unknown): boolean {
  if (isJsonErrorObject(value)) return true;
  return Array.isArray(value) && value.some((item) => isJsonErrorObject(item));
}

function isJsonErrorEvent(data: string): boolean {
  const json = parseJson(data);
  if (json === undefined) return false;
  return isJsonErrorEnvelope(json.value);
}

function replaceExactForms(text: string, forms: readonly string[]): string {
  let masked = text;
  for (const form of forms) {
    if (masked.includes(form)) {
      masked = masked.split(form).join(CREDENTIAL_MASK);
    }
  }
  return masked;
}

function maskExactCredentialsInValue(
  value: unknown,
  forms: readonly string[],
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const masked = replaceExactForms(value, forms);
    return { value: masked, changed: masked !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = maskExactCredentialsInValue(item, forms);
      if (next.changed) changed = true;
      return next.value;
    });
    return changed ? { value: mapped, changed: true } : { value, changed: false };
  }
  const isObject = value !== null && typeof value === 'object';
  if (!isObject) return { value, changed: false };
  let changed = false;
  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const maskedKey = replaceExactForms(key, forms);
    const nextItem = maskExactCredentialsInValue(item, forms);
    if (maskedKey !== key || nextItem.changed) changed = true;
    return [maskedKey, nextItem.value] as const;
  });
  return changed ? { value: Object.fromEntries(entries), changed: true } : { value, changed: false };
}

export interface RedactSuccessBodyOptions {
  /** Also mask exact server-configured credentials echoed in non-error 2xx payloads. */
  maskExactCredentials?: boolean;
}

/**
 * Mask a `2xx` non-streaming upstream body without applying URL-pattern
 * scrubbing to normal model answers (ADR 0024).
 */
export function redactUpstreamSuccessBody(
  text: string,
  credentials: readonly string[],
  options: RedactSuccessBodyOptions = {},
): string {
  const json = parseJson(text);
  if (json !== undefined && isJsonErrorEnvelope(json.value)) {
    return redactUpstreamError(text, credentials);
  }
  if (options.maskExactCredentials !== true) return text;
  const eligible = credentials.filter((credential) => credential.length >= MIN_SUCCESS_CREDENTIAL_LENGTH);
  if (eligible.length === 0) return text;
  const forms = quotedForms(eligible);
  if (json === undefined) {
    return replaceExactForms(text, forms);
  }
  const masked = maskExactCredentialsInValue(json.value, forms);
  if (!masked.changed) return text;
  return JSON.stringify(masked.value);
}

interface SseLine {
  raw: string;
  hasNewline: boolean;
}

interface ParsedSseLine {
  raw: string;
  hasNewline: boolean;
  carriageReturn: string;
  isEventError: boolean;
  dataPrefix: string | undefined;
  data: string | undefined;
}

function isBlankSseLine(raw: string): boolean {
  return raw === '' || raw === '\r';
}

function parseSseLine(line: SseLine): ParsedSseLine {
  const carriageReturn = line.raw.endsWith('\r') ? '\r' : '';
  const body = line.raw.slice(0, line.raw.length - carriageReturn.length);
  const dataPrefix = /^data: ?/.exec(body)?.[0];
  return {
    raw: line.raw,
    hasNewline: line.hasNewline,
    carriageReturn,
    isEventError: /^event:\s*error$/i.test(body),
    dataPrefix,
    data: dataPrefix === undefined ? undefined : body.slice(dataPrefix.length),
  };
}

function renderSseLines(lines: readonly SseLine[]): string {
  return lines.map((line) => (line.hasNewline ? `${line.raw}\n` : line.raw)).join('');
}

function maskSseEvent(eventLines: readonly SseLine[], credentials: readonly string[]): string {
  if (eventLines.length === 0) return '';
  const parsed = eventLines.map(parseSseLine);
  const dataLines = parsed.filter(
    (line): line is ParsedSseLine & { dataPrefix: string; data: string } =>
      line.dataPrefix !== undefined && line.data !== undefined,
  );
  const firstData = dataLines[0];
  if (firstData === undefined) return renderSseLines(eventLines);

  const eventIsError = parsed.some((line) => line.isEventError);
  const assembled =
    dataLines.length === 1 ? firstData.data : dataLines.map((line) => line.data).join('\n');

  if (eventIsError || isJsonErrorEvent(assembled)) {
    const maskedPayload = redactUpstreamError(assembled, credentials);
    const maskedParts = maskedPayload.split('\n');
    const lastOriginal = eventLines[eventLines.length - 1];
    const endsWithNewline = lastOriginal === undefined ? false : lastOriginal.hasNewline;
    const output: SseLine[] = [];
    let insertedMaskedData = false;
    for (const line of parsed) {
      if (line.dataPrefix !== undefined) {
        if (!insertedMaskedData) {
          insertedMaskedData = true;
          for (const part of maskedParts) {
            output.push({
              raw: `${firstData.dataPrefix}${part}${firstData.carriageReturn}`,
              hasNewline: true,
            });
          }
        }
        continue;
      }
      output.push({ raw: line.raw, hasNewline: true });
    }
    const lastOutput = output[output.length - 1];
    if (lastOutput !== undefined) {
      lastOutput.hasNewline = endsWithNewline;
    }
    return renderSseLines(output);
  }

  if (dataLines.length > 1) {
    let anyMasked = false;
    const fallbackLines: SseLine[] = parsed.map((line) => {
      if (line.dataPrefix === undefined || line.data === undefined || !isJsonErrorEvent(line.data)) {
        return { raw: line.raw, hasNewline: line.hasNewline };
      }
      anyMasked = true;
      const masked = redactUpstreamError(line.data, credentials);
      return {
        raw: `${line.dataPrefix}${masked}${line.carriageReturn}`,
        hasNewline: line.hasNewline,
      };
    });
    if (anyMasked) return renderSseLines(fallbackLines);
  }

  return renderSseLines(eventLines);
}

/**
 * Wraps an SSE `2xx` byte stream so any error event (`data: {"error": ...}`,
 * `data: [{"error": ...}]`, multi-line SSE JSON errors, or `event: error`) has
 * its credentials masked before reaching the caller, while flushing each
 * complete SSE event immediately in linear time without cross-event buffering.
 */
export function maskStreamErrors(
  body: ReadableStream<Uint8Array>,
  credentials: readonly string[],
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let eventLines: SseLine[] = [];
  let pending = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        const arrived = decoder.decode(bytes, { stream: true });
        const lastNewline = arrived.lastIndexOf('\n');
        if (lastNewline === -1) {
          pending += arrived;
          return;
        }
        const lines = (pending + arrived.slice(0, lastNewline)).split('\n');
        pending = arrived.slice(lastNewline + 1);
        let out = '';
        for (const line of lines) {
          if (isBlankSseLine(line)) {
            out += `${maskSseEvent(eventLines, credentials)}${line}\n`;
            eventLines = [];
          } else {
            eventLines.push({ raw: line, hasNewline: true });
          }
        }
        if (out !== '') {
          controller.enqueue(encoder.encode(out));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        let out = '';
        if (pending !== '') {
          if (isBlankSseLine(pending)) {
            out += `${maskSseEvent(eventLines, credentials)}${pending}`;
            eventLines = [];
          } else {
            eventLines.push({ raw: pending, hasNewline: false });
          }
        }
        if (eventLines.length > 0) {
          out += maskSseEvent(eventLines, credentials);
          eventLines = [];
        }
        if (out !== '') {
          controller.enqueue(encoder.encode(out));
        }
      },
    }),
  );
}
