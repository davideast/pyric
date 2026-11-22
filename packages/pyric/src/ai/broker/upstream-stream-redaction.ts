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
  MIN_EXACT_CREDENTIAL_LENGTH,
  redactTransformedCredentials,
} from './credential-transform-redaction.js';
import {
  parseJson,
  redactUpstreamError,
} from './upstream-error-redaction.js';

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

function maskExactCredentialsInValue(
  value: unknown,
  credentials: readonly string[],
): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const masked = redactTransformedCredentials(value, credentials);
    return { value: masked, changed: masked !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = maskExactCredentialsInValue(item, credentials);
      if (next.changed) changed = true;
      return next.value;
    });
    return changed ? { value: mapped, changed: true } : { value, changed: false };
  }
  const isObject = value !== null && typeof value === 'object';
  if (!isObject) return { value, changed: false };
  let changed = false;
  const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => {
    const maskedKey = redactTransformedCredentials(key, credentials);
    const nextItem = maskExactCredentialsInValue(item, credentials);
    if (maskedKey !== key || nextItem.changed) changed = true;
    return [maskedKey, nextItem.value] as const;
  });
  return changed ? { value: Object.fromEntries(entries), changed: true } : { value, changed: false };
}

export interface RedactSuccessBodyOptions {
  /** Also mask exact/transformed server-configured credentials echoed in non-error 2xx payloads. */
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
  const eligible = credentials.filter((credential) => credential.length >= MIN_EXACT_CREDENTIAL_LENGTH);
  if (eligible.length === 0) return text;
  if (json === undefined) {
    return redactTransformedCredentials(text, eligible);
  }
  const masked = maskExactCredentialsInValue(json.value, eligible);
  if (!masked.changed) return text;
  return JSON.stringify(masked.value);
}

type SseLineTerminator = '\r\n' | '\n' | '\r' | '';

interface SseLine {
  raw: string;
  terminator: SseLineTerminator;
}

interface ParsedSseLine {
  raw: string;
  terminator: SseLineTerminator;
  isEventError: boolean;
  dataPrefix: string | undefined;
  data: string | undefined;
}

function parseSseLine(line: SseLine): ParsedSseLine {
  const dataPrefix = /^data: ?/.exec(line.raw)?.[0];
  return {
    raw: line.raw,
    terminator: line.terminator,
    isEventError: /^event:\s*error\s*$/i.test(line.raw),
    dataPrefix,
    data: dataPrefix === undefined ? undefined : line.raw.slice(dataPrefix.length),
  };
}

function renderSseLines(lines: readonly SseLine[]): string {
  return lines.map((line) => `${line.raw}${line.terminator}`).join('');
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
    const finalTerminator: SseLineTerminator =
      lastOriginal === undefined ? '' : lastOriginal.terminator;
    const partTerminator: SseLineTerminator =
      firstData.terminator === '' ? '\n' : firstData.terminator;
    const output: SseLine[] = [];
    let insertedMaskedData = false;
    for (const line of parsed) {
      if (line.dataPrefix !== undefined) {
        if (!insertedMaskedData) {
          insertedMaskedData = true;
          for (const part of maskedParts) {
            output.push({
              raw: `${firstData.dataPrefix}${part}`,
              terminator: partTerminator,
            });
          }
        }
        continue;
      }
      output.push({ raw: line.raw, terminator: line.terminator === '' ? partTerminator : line.terminator });
    }
    const lastOutput = output[output.length - 1];
    if (lastOutput !== undefined) {
      lastOutput.terminator = finalTerminator;
    }
    return renderSseLines(output);
  }

  if (dataLines.length > 1) {
    let anyMasked = false;
    const fallbackLines: SseLine[] = parsed.map((line) => {
      if (line.dataPrefix === undefined || line.data === undefined || !isJsonErrorEvent(line.data)) {
        return { raw: line.raw, terminator: line.terminator };
      }
      anyMasked = true;
      const masked = redactUpstreamError(line.data, credentials);
      return {
        raw: `${line.dataPrefix}${masked}`,
        terminator: line.terminator,
      };
    });
    if (anyMasked) return renderSseLines(fallbackLines);
  }

  return renderSseLines(eventLines);
}

function drainCompleteSseLines(
  buffer: string,
  eventLines: SseLine[],
  credentials: readonly string[],
): { out: string; pending: string } {
  let out = '';
  let start = 0;
  let i = 0;
  while (i < buffer.length) {
    const ch = buffer.charAt(i);
    if (ch === '\r') {
      if (i + 1 === buffer.length) {
        // Hold a trailing CR until the next chunk reveals whether it is CRLF or bare CR.
        break;
      }
      const isCrLf = buffer.charAt(i + 1) === '\n';
      const terminator: SseLineTerminator = isCrLf ? '\r\n' : '\r';
      const raw = buffer.slice(start, i);
      i += isCrLf ? 2 : 1;
      start = i;
      if (raw === '') {
        out += `${maskSseEvent(eventLines, credentials)}${terminator}`;
        eventLines.length = 0;
      } else {
        eventLines.push({ raw, terminator });
      }
      continue;
    }
    if (ch === '\n') {
      const raw = buffer.slice(start, i);
      i += 1;
      start = i;
      if (raw === '') {
        out += `${maskSseEvent(eventLines, credentials)}\n`;
        eventLines.length = 0;
      } else {
        eventLines.push({ raw, terminator: '\n' });
      }
      continue;
    }
    i += 1;
  }
  return { out, pending: buffer.slice(start) };
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
  const eventLines: SseLine[] = [];
  let pending = '';
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, controller) {
        const arrived = decoder.decode(bytes, { stream: true });
        if (arrived.length === 0) return;
        const hasLineBreak = arrived.includes('\n') || arrived.includes('\r');
        const pendingEndsWithCr = pending.endsWith('\r');
        if (!hasLineBreak && !pendingEndsWithCr) {
          pending += arrived;
          return;
        }
        const drained = drainCompleteSseLines(pending + arrived, eventLines, credentials);
        pending = drained.pending;
        if (drained.out !== '') {
          controller.enqueue(encoder.encode(drained.out));
        }
      },
      flush(controller) {
        pending += decoder.decode();
        let out = '';
        if (pending !== '') {
          const drained = drainCompleteSseLines(pending, eventLines, credentials);
          out += drained.out;
          pending = drained.pending;
        }
        if (pending !== '') {
          if (pending === '\r') {
            out += `${maskSseEvent(eventLines, credentials)}\r`;
            eventLines.length = 0;
          } else if (pending.endsWith('\r')) {
            eventLines.push({ raw: pending.slice(0, -1), terminator: '\r' });
          } else {
            eventLines.push({ raw: pending, terminator: '' });
          }
          pending = '';
        }
        if (eventLines.length > 0) {
          out += maskSseEvent(eventLines, credentials);
          eventLines.length = 0;
        }
        if (out !== '') {
          controller.enqueue(encoder.encode(out));
        }
      },
    }),
  );
}
