// Shared wire-format serializer and Markdown/HTML-aware parser for SHA-pinned
// Advisor campaign review verdict markers on pull request comments.

export type CampaignAxis = 'spec' | 'standards';
export type CampaignVerdict = 'MERGE' | 'FIX';

export interface VerdictMarkerInput {
  axis: CampaignAxis;
  verdict: CampaignVerdict;
  sha: string;
}

export interface VerdictCommentInput extends VerdictMarkerInput {
  summary: string;
}

export interface ParsedCommentVerdictTokens {
  markers: VerdictMarkerInput[];
  malformedMarkers: string[];
  hasUnclosedContainer: boolean;
}

const VALID_AXES: ReadonlySet<string> = new Set(['spec', 'standards']);
const VALID_VERDICTS: ReadonlySet<string> = new Set(['MERGE', 'FIX']);
const FULL_HEX_SHA = /^[0-9a-f]{40}$/i;
const PLAIN_ASCII = /^[\x00-\x7f]*$/;

const ROOT_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const LIST_FENCE_OPEN = /^(?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)+[ \t]*(`{3,}|~{3,})(.*)$/;
const COLUMN_ZERO_HTML_COMMENT = /^<!--([\s\S]*?)-->[ \t]*$/;
const CAMPAIGN_COMMENT_PREFIX = /^campaign-verdict(?:\s|$)/i;
const CANONICAL_INNER_MARKER =
  /^campaign-verdict\s+axis=(spec|standards)\s+verdict=(merge|fix)\s+sha=([0-9a-f]{40})$/i;
const CONTAINER_TAG_AT_START = /^<(\/?)(pre|code|blockquote)(?=\s|>)(?:[^>]*)>/i;

interface ActiveFence {
  char: string;
  length: number;
  inList: boolean;
}

interface HtmlScanState {
  inComment: boolean;
  pre: number;
  code: number;
  blockquote: number;
}

export function normalizeCommitSha(sha: string): string {
  const trimmed = sha.trim();
  if (!FULL_HEX_SHA.test(trimmed)) {
    throw new Error(`Expected a 40-character hex commit SHA, received "${sha}".`);
  }
  return trimmed.toLowerCase();
}

export function assertValidAxis(axis: string): asserts axis is CampaignAxis {
  if (!VALID_AXES.has(axis)) {
    throw new Error(`Expected --axis to be "spec" or "standards", received "${axis}".`);
  }
}

export function assertValidVerdict(verdict: string): asserts verdict is CampaignVerdict {
  if (!VALID_VERDICTS.has(verdict)) {
    throw new Error(`Expected --verdict to be "MERGE" or "FIX", received "${verdict}".`);
  }
}

function stripInlineBacktickSpans(line: string): string {
  return line.replace(/`+[^`]*`+/g, '');
}

function detectOpeningFence(line: string): ActiveFence | undefined {
  const rootMatch = ROOT_FENCE_OPEN.exec(line);
  if (rootMatch !== null) {
    const delimiter = rootMatch[1] ?? '';
    const info = rootMatch[2] ?? '';
    const char = delimiter[0] ?? '';
    if (char !== '' && !(char === '`' && info.includes('`'))) {
      return { char, length: delimiter.length, inList: false };
    }
  }
  const listMatch = LIST_FENCE_OPEN.exec(line);
  if (listMatch !== null) {
    const delimiter = listMatch[1] ?? '';
    const info = listMatch[2] ?? '';
    const char = delimiter[0] ?? '';
    if (char !== '' && !(char === '`' && info.includes('`'))) {
      return { char, length: delimiter.length, inList: true };
    }
  }
  return undefined;
}

function isClosingFence(line: string, fence: ActiveFence): boolean {
  let trimmedStart: string;
  if (fence.inList) {
    trimmedStart = line.replace(/^[ \t]*/, '');
  } else {
    if (line.startsWith('    ') || line.startsWith('\t')) return false;
    trimmedStart = line.replace(/^ {0,3}/, '');
  }
  let runLength = 0;
  while (runLength < trimmedStart.length && trimmedStart[runLength] === fence.char) {
    runLength++;
  }
  if (runLength < fence.length) return false;
  const trailing = trimmedStart.slice(runLength);
  return /^[ \t]*$/.test(trailing);
}

function isIndentedOrBlockquoteLine(line: string): boolean {
  if (line.startsWith('    ') || line.startsWith('\t')) return true;
  return /^ {0,3}>/.test(line);
}

function isInsideHtmlContainer(state: HtmlScanState): boolean {
  return state.inComment || state.pre > 0 || state.code > 0 || state.blockquote > 0;
}

function scanHtmlLine(lineWithoutBackticks: string, state: HtmlScanState): void {
  let cursor = 0;
  while (cursor < lineWithoutBackticks.length) {
    if (state.inComment) {
      const closeIdx = lineWithoutBackticks.indexOf('-->', cursor);
      if (closeIdx === -1) return;
      state.inComment = false;
      cursor = closeIdx + 3;
      continue;
    }

    const nextLt = lineWithoutBackticks.indexOf('<', cursor);
    if (nextLt === -1) return;
    cursor = nextLt;

    if (lineWithoutBackticks.startsWith('<!--', cursor)) {
      const closeIdx = lineWithoutBackticks.indexOf('-->', cursor + 4);
      if (closeIdx === -1) {
        state.inComment = true;
        return;
      }
      cursor = closeIdx + 3;
      continue;
    }

    const tagMatch = CONTAINER_TAG_AT_START.exec(lineWithoutBackticks.slice(cursor));
    if (tagMatch !== null) {
      const isClose = tagMatch[1] === '/';
      const tag = (tagMatch[2] ?? '').toLowerCase() as 'pre' | 'code' | 'blockquote';
      if (isClose) {
        if (state[tag] > 0) state[tag]--;
      } else {
        state[tag]++;
      }
      cursor += tagMatch[0].length;
      continue;
    }

    cursor++;
  }
}

export function parseCommentVerdictTokens(body: string): ParsedCommentVerdictTokens {
  const markers: VerdictMarkerInput[] = [];
  const malformedMarkers: string[] = [];
  const lines = body.replace(/\r\n?/g, '\n').split('\n');

  let activeFence: ActiveFence | undefined;
  const htmlState: HtmlScanState = {
    inComment: false,
    pre: 0,
    code: 0,
    blockquote: 0,
  };

  for (const line of lines) {
    if (activeFence !== undefined) {
      if (isClosingFence(line, activeFence)) {
        activeFence = undefined;
      }
      continue;
    }

    if (!htmlState.inComment) {
      const openedFence = detectOpeningFence(line);
      if (openedFence !== undefined) {
        activeFence = openedFence;
        continue;
      }
    }

    if (isIndentedOrBlockquoteLine(line)) {
      continue;
    }

    if (!isInsideHtmlContainer(htmlState)) {
      const colZeroComment = COLUMN_ZERO_HTML_COMMENT.exec(line);
      if (colZeroComment !== null) {
        const innerRaw = colZeroComment[1] ?? '';
        const hasNestedDelimiter = innerRaw.includes('<!--') || innerRaw.includes('-->');
        const innerTrimmed = innerRaw.trim();
        if (!hasNestedDelimiter && CAMPAIGN_COMMENT_PREFIX.test(innerTrimmed)) {
          const canonical = CANONICAL_INNER_MARKER.exec(innerTrimmed);
          if (canonical !== null) {
            const axis = (canonical[1] ?? '').toLowerCase() as CampaignAxis;
            const verdict = (canonical[2] ?? '').toUpperCase() as CampaignVerdict;
            const sha = normalizeCommitSha(canonical[3] ?? '');
            markers.push({ axis, verdict, sha });
          } else {
            malformedMarkers.push(line.trim());
          }
          continue;
        }
      }
    }

    const withoutBackticks = stripInlineBacktickSpans(line);
    scanHtmlLine(withoutBackticks, htmlState);
  }

  const hasUnclosedContainer = activeFence !== undefined || isInsideHtmlContainer(htmlState);
  return { markers, malformedMarkers, hasUnclosedContainer };
}

export function parseVerdictMarkers(body: string): VerdictMarkerInput[] {
  return parseCommentVerdictTokens(body).markers;
}

function assertValidSummary(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    throw new Error('Verdict summary must not be empty.');
  }
  if (!PLAIN_ASCII.test(trimmed)) {
    throw new Error('Verdict summary must contain only plain ASCII characters (<= 127).');
  }
  if (trimmed.includes('<!--') || trimmed.includes('-->')) {
    throw new Error('Verdict summary must not contain HTML comment delimiters.');
  }
  const summaryScan = parseCommentVerdictTokens(trimmed);
  if (summaryScan.hasUnclosedContainer) {
    throw new Error('Verdict summary leaves an unclosed Markdown code fence or HTML container.');
  }
  return trimmed;
}

export function formatVerdictMarker(input: VerdictMarkerInput): string {
  assertValidAxis(input.axis);
  assertValidVerdict(input.verdict);
  const sha = normalizeCommitSha(input.sha);
  return `<!-- campaign-verdict axis=${input.axis} verdict=${input.verdict} sha=${sha} -->`;
}

export function formatVerdictComment(input: VerdictCommentInput): string {
  const marker = formatVerdictMarker(input);
  const sha = normalizeCommitSha(input.sha);
  const summary = assertValidSummary(input.summary);
  const comment = [
    `**Campaign review (\`${input.axis}\`):** \`${input.verdict}\` at \`${sha}\``,
    '',
    summary,
    '',
    marker,
  ].join('\n');

  const roundTrip = parseCommentVerdictTokens(comment);
  const singleMatch = roundTrip.markers[0];
  const roundTripValid =
    !roundTrip.hasUnclosedContainer
    && roundTrip.malformedMarkers.length === 0
    && roundTrip.markers.length === 1
    && singleMatch !== undefined
    && singleMatch.axis === input.axis
    && singleMatch.verdict === input.verdict
    && singleMatch.sha === sha;
  if (!roundTripValid) {
    throw new Error('Formatted verdict comment failed marker round-trip verification.');
  }

  return comment;
}
