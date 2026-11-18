#!/usr/bin/env bash
# Safely unlinks a linked git worktree and prunes git's worktree metadata.
# Never renames into .trash* or /tmp (which preserves inodes and disk blocks),
# and refuses main checkouts where .git is a directory rather than a gitfile.
#
# Usage:
#   scripts/worktree-remove.sh [--force] [--delete-branch <branch>] <worktree-path>

set -euo pipefail

FORCE=0
DELETE_BRANCH=""
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -f|--force)
      FORCE=1
      shift
      ;;
    --delete-branch)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "error: --delete-branch requires a branch name" >&2
        exit 2
      fi
      DELETE_BRANCH="$2"
      shift 2
      ;;
    --delete-branch=*)
      DELETE_BRANCH="${1#*=}"
      shift
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/worktree-remove.sh [--force] [--delete-branch <branch>] <worktree-path>

Removes a linked git worktree via real filesystem unlink (`rm -rf`) followed by
`git worktree prune`, freeing disk blocks and inodes immediately.

Options:
  -f, --force               Remove even when the worktree has uncommitted changes.
  --delete-branch <branch>  Delete the local branch after pruning the worktree.

Safety checks:
  - Refuses empty, `/`, `$HOME`, or `.trash*` paths.
  - Refuses canonical main checkouts (`.git` directory instead of `.git` file).
  - Refuses dirty or untracked files unless `--force` is passed.
EOF
      exit 0
      ;;
    *)
      if [[ -n "$TARGET" ]]; then
        echo "error: expected a single <worktree-path>, got extra argument '$1'" >&2
        exit 2
      fi
      TARGET="$1"
      shift
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "error: missing <worktree-path>" >&2
  exit 2
fi

case "$DELETE_BRANCH" in
  main|master)
    echo "error: refusing to delete protected branch '$DELETE_BRANCH'" >&2
    exit 1
    ;;
esac

case "$TARGET" in
  *.trash*|*/.trash*)
    echo "error: refusing .trash path '$TARGET' (always unlink worktrees directly)" >&2
    exit 1
    ;;
esac

if [[ ! -e "$TARGET" ]]; then
  echo "error: worktree path does not exist: $TARGET" >&2
  exit 1
fi

ABS_TARGET="$(cd "$TARGET" && pwd -P)"
HOME_REAL=""
if [[ -n "${HOME:-}" && -d "${HOME}" ]]; then
  HOME_REAL="$(cd "${HOME}" && pwd -P)"
fi

if [[ "$ABS_TARGET" == "/" || "$ABS_TARGET" == "$HOME_REAL" ]]; then
  echo "error: refusing unsafe target '$ABS_TARGET'" >&2
  exit 1
fi

case "$ABS_TARGET" in
  *.trash*|*/.trash*)
    echo "error: refusing .trash path '$ABS_TARGET'" >&2
    exit 1
    ;;
esac

if [[ -d "$ABS_TARGET/.git" ]]; then
  echo "error: refusing to remove main git repository checkout ($ABS_TARGET/.git is a directory)" >&2
  exit 1
fi

if [[ ! -f "$ABS_TARGET/.git" ]]; then
  echo "error: '$ABS_TARGET' is not a linked git worktree (missing .git file)" >&2
  exit 1
fi

COMMON_GIT_DIR="$(git -C "$ABS_TARGET" rev-parse --path-format=absolute --git-common-dir)"

if [[ "$FORCE" -eq 0 ]]; then
  DIRTY="$(git -C "$ABS_TARGET" status --porcelain)"
  if [[ -n "$DIRTY" ]]; then
    echo "error: worktree '$ABS_TARGET' has uncommitted or untracked changes (pass --force to remove anyway)" >&2
    exit 1
  fi
fi

cd "$(dirname "$COMMON_GIT_DIR")" || cd /

rm -rf \
  "$ABS_TARGET/node_modules" \
  "$ABS_TARGET"/packages/*/node_modules \
  "$ABS_TARGET"/packages/*/dist \
  "$ABS_TARGET/dist" \
  "$ABS_TARGET/test-results"
rm -rf "$ABS_TARGET"

git --git-dir="$COMMON_GIT_DIR" worktree prune

if [[ -n "$DELETE_BRANCH" ]]; then
  git --git-dir="$COMMON_GIT_DIR" branch -D "$DELETE_BRANCH"
fi

if [[ -e "$ABS_TARGET" ]]; then
  echo "error: failed to completely unlink '$ABS_TARGET'" >&2
  exit 1
fi
