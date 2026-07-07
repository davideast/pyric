/**
 * Claude Code MCP transcript filter — strips internal tool markup
 * (`<function_calls>`, `<function_result>`, …) from the user-visible
 * reply while surfacing compact delegated-activity rows.
 *
 * Claude `-p` in MCP mode streams its whole agent transcript as plain
 * `text_delta` chunks. The playground's delegate lane passes those
 * through unless filtered here.
 */

export interface DelegatedActivity {
  id: string;
  /** Display name (mcp__playground__ prefix stripped). */
  name: string;
  summary: string;
  resultSummary?: string;
  ts: number;
}

export interface ClaudeTranscriptPushResult {
  cleanText: string;
  activities: DelegatedActivity[];
  /** Patches `resultSummary` on a prior activity from an earlier push. */
  activityUpdates: Array<{ id: string; resultSummary: string }>;
}

const OPEN_CALLS = '<function_calls>';
const CLOSE_CALLS = '</function_calls>';
const OPEN_RESULT = '<function_result>';
const CLOSE_RESULT = '</function_result>';

const TAG_PREFIXES = [
  OPEN_CALLS,
  CLOSE_CALLS,
  OPEN_RESULT,
  CLOSE_RESULT,
  '<invoke',
  '</invoke>',
  '<parameter',
  '</parameter>',
];

function normalizeProse(s: string): string {
  return s.replace(/\n{3,}/g, '\n\n');
}

/** One-shot cleanup for stored text (turn_completed belt-and-suspenders). */
export function finalizeClaudeTranscript(text: string): string {
  const filter = new ClaudeTranscriptFilter();
  const { cleanText } = filter.push(text);
  const tail = filter.flush();
  return normalizeProse(cleanText + tail.cleanText).trim();
}

function holdbackPartialTag(s: string): number {
  const lastLt = s.lastIndexOf('<');
  if (lastLt === -1) return s.length;
  const tail = s.slice(lastLt);
  for (const prefix of TAG_PREFIXES) {
    if (tail.length <= prefix.length && prefix.startsWith(tail)) return lastLt;
  }
  return s.length;
}

function displayToolName(fullName: string): string {
  return fullName.replace(/^mcp__playground__/, '');
}

function parseParameters(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    params[m[1]!] = m[2] ?? '';
  }
  return params;
}

function countLines(s: string): number {
  if (!s) return 0;
  return s.split('\n').length;
}

function summarizeInvoke(fullName: string, params: Record<string, string>): string {
  const name = displayToolName(fullName);
  const path = params.path?.trim();
  switch (name) {
    case 'write_file':
      return path
        ? `wrote ${path}${params.content ? ` · ${countLines(params.content)} lines` : ''}`
        : 'wrote file';
    case 'read_file':
      return path ? `read ${path}` : 'read file';
    case 'delete_file':
      return path ? `deleted ${path}` : 'deleted file';
    case 'list_files':
      return 'listed workspace files';
    case 'run_workspace_tests':
      return 'ran workspace tests';
    case 'simulate_firestore_write':
      return 'simulated Firestore write';
    case 'firestore_rules_stdlib_list':
      return 'listed rules stdlib';
    case 'firestore_rules_stdlib_get':
      return params.key ? `read stdlib · ${params.key}` : 'read stdlib module';
    case 'firestore_lint_rules':
      return 'linted Firestore rules';
    case 'bash':
      return 'ran shell command';
    default:
      return name.replace(/_/g, ' ');
  }
}

function parseFunctionCallsBlock(block: string, nextId: () => string): DelegatedActivity[] {
  const out: DelegatedActivity[] = [];
  const re = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    const params = parseParameters(m[2] ?? '');
    out.push({
      id: nextId(),
      name: displayToolName(m[1] ?? 'tool'),
      summary: summarizeInvoke(m[1] ?? '', params),
      ts: Date.now(),
    });
  }
  return out;
}

function summarizeFunctionResult(inner: string): string {
  const trimmed = inner.trim();
  if (!trimmed) return 'done';
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { keys?: unknown[] };
      if (Array.isArray(parsed.keys)) return `${parsed.keys.length} keys`;
    } catch {
      /* fall through */
    }
  }
  const firstLine = trimmed.split('\n').find((l) => l.trim().length > 0) ?? trimmed;
  return firstLine.trim().slice(0, 120);
}

function applyFunctionResult(
  block: string,
  emitted: DelegatedActivity[],
  updates: Array<{ id: string; resultSummary: string }>,
): void {
  const inner = block
    .slice(OPEN_RESULT.length, block.length - CLOSE_RESULT.length)
    .trim();
  const summary = summarizeFunctionResult(inner);
  const last = emitted.at(-1);
  if (!last) return;
  last.resultSummary = summary;
  updates.push({ id: last.id, resultSummary: summary });
}

export class ClaudeTranscriptFilter {
  private buffer = '';
  private rawText = '';
  private seq = 0;
  private emitted: DelegatedActivity[] = [];

  get raw(): string {
    return this.rawText;
  }

  private nextId(): string {
    this.seq += 1;
    return `da-${this.seq}-${Date.now().toString(36)}`;
  }

  /** Trailing `\n` count from the last emitted clean chunk — used to
   *  collapse blank-line gaps split across stream chunks. */
  private trailingNewlines = 0;

  private collapseChunkGap(text: string): string {
    if (!text || this.trailingNewlines === 0) return text;
    const leading = text.match(/^\n+/);
    if (!leading) return text;
    const collapse = Math.min(leading[0]!.length, this.trailingNewlines);
    return text.slice(collapse);
  }

  private noteTrailingNewlines(text: string): void {
    if (!text) return;
    const trailing = text.match(/\n+$/);
    this.trailingNewlines = trailing ? trailing[0]!.length : 0;
  }

  push(chunk: string): ClaudeTranscriptPushResult {
    this.rawText += chunk;
    this.buffer += chunk;
    const result = this.drain(false);
    result.cleanText = this.collapseChunkGap(result.cleanText);
    this.noteTrailingNewlines(result.cleanText);
    return result;
  }

  flush(): ClaudeTranscriptPushResult {
    const result = this.drain(true);
    result.cleanText = this.collapseChunkGap(result.cleanText);
    this.noteTrailingNewlines(result.cleanText);
    return result;
  }

  private drain(flush: boolean): ClaudeTranscriptPushResult {
    let cleanText = '';
    const activities: DelegatedActivity[] = [];
    const activityUpdates: Array<{ id: string; resultSummary: string }> = [];

    for (;;) {
      const callsIdx = this.buffer.indexOf(OPEN_CALLS);
      const resultIdx = this.buffer.indexOf(OPEN_RESULT);
      let nextTag = -1;
      let kind: 'calls' | 'result' | null = null;

      if (callsIdx !== -1 && (resultIdx === -1 || callsIdx <= resultIdx)) {
        nextTag = callsIdx;
        kind = 'calls';
      } else if (resultIdx !== -1) {
        nextTag = resultIdx;
        kind = 'result';
      }

      if (nextTag === -1) {
        while (cleanText.endsWith('\n') && this.buffer.startsWith('\n')) {
          this.buffer = this.buffer.slice(1);
        }
        if (flush) {
          cleanText += this.buffer;
          this.buffer = '';
        } else {
          const hold = holdbackPartialTag(this.buffer);
          cleanText += this.buffer.slice(0, hold);
          this.buffer = this.buffer.slice(hold);
        }
        break;
      }

      cleanText += this.buffer.slice(0, nextTag);
      this.buffer = this.buffer.slice(nextTag);

      const closeTag = kind === 'calls' ? CLOSE_CALLS : CLOSE_RESULT;
      const closeIdx = this.buffer.indexOf(closeTag);
      if (closeIdx === -1) {
        if (!flush) break;
        this.buffer = '';
        break;
      }

      const block = this.buffer.slice(0, closeIdx + closeTag.length);
      this.buffer = this.buffer.slice(closeIdx + closeTag.length);

      if (kind === 'calls') {
        const parsed = parseFunctionCallsBlock(block, () => this.nextId());
        this.emitted.push(...parsed);
        activities.push(...parsed);
      } else {
        applyFunctionResult(block, this.emitted, activityUpdates);
      }

      while (cleanText.endsWith('\n') && this.buffer.startsWith('\n')) {
        this.buffer = this.buffer.slice(1);
      }
    }

    return {
      cleanText: normalizeProse(cleanText),
      activities,
      activityUpdates,
    };
  }
}
