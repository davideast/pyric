/**
 * On a live host, Settings still acts on the local sandbox: Export, Import,
 * Save state and Reset never reach the Firebase project the host forwards to.
 * This line says so, naming that project. Without a live host it renders
 * nothing, and Settings reads as it always has.
 */

export interface LiveSandboxNoticeProps {
  /** The live host's Firebase project, or null on a sandbox host. */
  readonly projectId: string | null;
}

export function LiveSandboxNotice({ projectId }: LiveSandboxNoticeProps) {
  if (projectId === null) return null;
  return (
    <p className="studio-live-notice" role="status" data-live-notice="">
      <span className="studio-live-notice__label">Sandbox</span>
      <span className="studio-live-notice__text">
        These controls change the local sandbox, not{' '}
        <span className="studio-live-notice__project" data-live-notice-project="">
          {projectId}
        </span>
        .
      </span>
    </p>
  );
}
