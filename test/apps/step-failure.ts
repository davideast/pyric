/**
 * Error thrown when a named scenario step fails, carrying the step name and
 * underlying failure reason for the runner's report.
 */
export class StepFailure extends Error {
  constructor(readonly step: string, readonly reason: unknown) {
    const detail = reason instanceof Error ? reason.message : String(reason);
    super(`step "${step}" failed: ${detail}`);
  }
}
