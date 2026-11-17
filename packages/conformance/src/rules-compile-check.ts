/**
 * Shared `projects.test` compile-check capture helper for Firestore and Storage
 * rules corpus scenarios marked `allowCompileError: true`.
 *
 * Records verbatim compile diagnostics (`COMPILE_ERROR` on HTTP 200 `issues`
 * without `testResults`, or `INVALID_ARGUMENT` on HTTP 400 JSON rules/request
 * rejections) instead of aborting the capture run, while still throwing on
 * auth/permission/quota/server failures (`401`, `403`, `429`, `5xx`).
 */
import type { ProjectScope } from '../../../packages/pyric/src/project-scope.ts';

interface RawCompileIssue {
  severity?: string;
  description?: string;
  sourcePosition?: { line?: number; column?: number };
}

interface RawGoogleRpcError {
  code?: number;
  message?: string;
  status?: string;
  details?: unknown[];
}

interface RawTestApiResponse {
  issues?: RawCompileIssue[];
  error?: RawGoogleRpcError;
  testResults?: Array<{
    state?: 'SUCCESS' | 'FAILURE';
    debugMessages?: string[];
  }>;
}

interface NormalizedCompileIssue {
  severity: string;
  description: string;
  line?: number;
  column?: number;
}

type CompileCheckVerdict = 'ALLOW' | 'DENY' | 'COMPILE_ERROR' | 'INVALID_ARGUMENT';

export interface CompileCheckCaptureResult {
  behavior: Record<string, CompileCheckVerdict>;
  diagnostics: Record<string, { notes: string[]; api?: unknown }>;
}

export interface CompileCheckCaseInput {
  description: string;
  expectation: 'ALLOW' | 'DENY';
}

function normalizeCompileIssues(rawIssues: readonly RawCompileIssue[]): {
  normalizedIssues: NormalizedCompileIssue[];
  issueNotes: string[];
} {
  const normalizedIssues: NormalizedCompileIssue[] = [];
  const issueNotes: string[] = [];

  for (const issue of rawIssues) {
    const entry: NormalizedCompileIssue = {
      severity: issue.severity ?? 'SEVERITY_UNSPECIFIED',
      description: issue.description ?? '',
    };
    if (issue.sourcePosition?.line !== undefined) {
      entry.line = issue.sourcePosition.line;
    }
    if (issue.sourcePosition?.column !== undefined) {
      entry.column = issue.sourcePosition.column;
    }
    normalizedIssues.push(entry);

    let pos = '';
    if (entry.line !== undefined) {
      const colText = entry.column !== undefined ? String(entry.column) : '?';
      pos = `@${entry.line}:${colText}`;
    }
    issueNotes.push(`${entry.severity}${pos} ${entry.description}`.trim());
  }

  return { normalizedIssues, issueNotes };
}

export async function captureRulesTestApiCompileCheck(options: {
  scenarioId: string;
  sourceFileName: 'firestore.rules' | 'storage.rules';
  rules: string;
  cases: readonly CompileCheckCaseInput[];
  apiTestCases: readonly unknown[];
  scope: ProjectScope;
  fetchImpl?: typeof fetch;
}): Promise<CompileCheckCaptureResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const token = await options.scope.resolveToken();
  const res = await fetchFn(
    `https://firebaserules.googleapis.com/v1/projects/${options.scope.projectId}:test`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source: { files: [{ name: options.sourceFileName, content: options.rules }] },
        testSuite: { testCases: options.apiTestCases },
      }),
    },
  );

  if (res.status === 400) {
    const rawText = await res.text().catch(() => '');
    let parsed400: RawTestApiResponse | null = null;
    try {
      parsed400 = JSON.parse(rawText) as RawTestApiResponse;
    } catch {
      parsed400 = null;
    }
    if (parsed400 && (parsed400.error !== undefined || parsed400.issues !== undefined)) {
      const { normalizedIssues, issueNotes } = normalizeCompileIssues(parsed400.issues ?? []);
      const notes = [...issueNotes];
      if (parsed400.error) {
        const statusLabel = parsed400.error.status ?? 'INVALID_ARGUMENT';
        const messageText = parsed400.error.message ?? '';
        notes.push(`${statusLabel} ${messageText}`.trim());
      }
      const apiRecord: Record<string, unknown> = { httpStatus: 400 };
      if (normalizedIssues.length > 0) {
        apiRecord.issues = normalizedIssues;
      }
      if (parsed400.error !== undefined) {
        apiRecord.error = parsed400.error;
      }
      const behavior = Object.fromEntries(
        options.cases.map((tc) => [tc.description, 'INVALID_ARGUMENT' as const]),
      );
      return {
        behavior,
        diagnostics: {
          compileIssues: {
            notes,
            api: apiRecord,
          },
        },
      };
    }
    throw new Error(
      `Production Rules Test API HTTP 400 for scenario "${options.scenarioId}": ${rawText}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Production Rules Test API HTTP ${res.status} for scenario "${options.scenarioId}": ${body}`,
    );
  }

  const data = (await res.json()) as RawTestApiResponse;
  const { normalizedIssues, issueNotes } = normalizeCompileIssues(data.issues ?? []);

  const testResults = data.testResults ?? [];
  const diagnostics: Record<string, { notes: string[]; api?: unknown }> = {};
  if (normalizedIssues.length > 0) {
    diagnostics.compileIssues = {
      notes: issueNotes,
      api: { issues: normalizedIssues },
    };
  }

  if (testResults.length === 0 && normalizedIssues.length > 0) {
    const behavior = Object.fromEntries(
      options.cases.map((tc) => [tc.description, 'COMPILE_ERROR' as const]),
    );
    return { behavior, diagnostics };
  }

  if (testResults.length !== options.cases.length) {
    throw new Error(
      `Rules Test API returned ${testResults.length} result(s) for ${options.cases.length} case(s) in "${options.scenarioId}"`,
    );
  }

  const behavior: Record<string, CompileCheckVerdict> = {};
  for (let i = 0; i < options.cases.length; i += 1) {
    const tc = options.cases[i];
    const apiResult = testResults[i];
    if (!tc) continue;
    const passed = apiResult?.state === 'SUCCESS';
    let decision: 'ALLOW' | 'DENY';
    if (passed) {
      decision = tc.expectation;
    } else {
      decision = tc.expectation === 'ALLOW' ? 'DENY' : 'ALLOW';
    }
    behavior[tc.description] = decision;
    const notes = apiResult?.debugMessages ?? [];
    if (notes.length > 0) {
      diagnostics[tc.description] = { notes: [...notes] };
    }
  }
  return { behavior, diagnostics };
}
