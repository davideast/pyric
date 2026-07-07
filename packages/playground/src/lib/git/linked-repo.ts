/**
 * Session-linked GitHub repo — single source for publish tool routing.
 */
import { parseRepoFullName } from './branch-policy';
import { useGithubSessionStore } from '~/lib/store/github-session';

export function getLinkedGitHubRepo() {
  return useGithubSessionStore.getState().linkedRepo;
}

/** Resolve owner/name for publish tools; prefer the session-linked repo. */
export function resolvePublishRepo(
  requested?: string,
): { ok: true; repo: string } | { ok: false; message: string } {
  const linked = getLinkedGitHubRepo();
  const trimmed = requested?.trim();

  if (linked) {
    if (trimmed && trimmed !== linked.fullName) {
      return {
        ok: false,
        message: `This session is linked to ${linked.fullName} — do not use ${trimmed}.`,
      };
    }
    return { ok: true, repo: linked.fullName };
  }

  if (!trimmed) {
    return {
      ok: false,
      message:
        'No linked GitHub repo on this session — pass repo owner/name or create the repo from the home page first.',
    };
  }

  try {
    parseRepoFullName(trimmed);
    return { ok: true, repo: trimmed };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, message };
  }
}

export function assertNoLinkedRepoForCreate(): { ok: true } | { ok: false; message: string } {
  const linked = getLinkedGitHubRepo();
  if (!linked) return { ok: true };
  return {
    ok: false,
    message: `Session already linked to ${linked.fullName} — use github_push_branch, not github_create_repo.`,
  };
}
