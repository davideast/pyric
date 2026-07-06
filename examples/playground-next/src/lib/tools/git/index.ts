import type { ToolHandler } from '@inbrowser/agent';

import { githubCreatePullRequestHandler } from './githubCreatePullRequest';
import { githubCreateRepoHandler } from './githubCreateRepo';
import { githubPushBranchHandler } from './githubPushBranch';

/** GitHub publish tools — browser PAT gated at execution time. */
export const GITHUB_TOOLS: readonly ToolHandler[] = [
  githubCreateRepoHandler as ToolHandler,
  githubPushBranchHandler as ToolHandler,
  githubCreatePullRequestHandler as ToolHandler,
];
