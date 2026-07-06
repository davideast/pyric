/**
 * Compact toolbar chip showing the last successful deploy time (or a
 * failure pulse). Reads from `useRuntimeStore.lastDeploy`, which is
 * written by both `useRulesAutoDeploy` and the Run button's
 * `executeWorkspace` call — same source of truth either way.
 *
 * Visual:
 *   ● 17:42 (green dot, time)        — last deploy ok
 *   ● failed (red dot, "failed")     — last attempt rejected by lint
 *   ○ deploying…                     — debounce window or no deploy yet
 */
import { useRuntimeStore } from '~/lib/store/runtime';

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function DeployChip() {
  const lastDeploy = useRuntimeStore((s) => s.lastDeploy);

  // No deploy yet — render nothing. Previously surfaced a "deploying…"
  // placeholder, but on a pristine page (no rules authored) nothing is
  // actually in flight; the chip read as a permanent stuck-spinner.
  // The brief debounce window between typing and the real result lands
  // is too short to need an indicator of its own.
  if (!lastDeploy) return null;

  const ok = lastDeploy.ok;
  const dotColor = ok ? 'bg-[#a4d4a8]' : 'bg-[#f0a0a0]';
  const label = ok ? `deployed ${formatTime(lastDeploy.at)}` : 'deploy failed';

  // Mobile drops the text and just shows the colored dot to save space
  // in the toolbar; full label re-appears at `sm:` and up. Tooltip
  // still carries the exact time / error message for tap-to-inspect.
  return (
    <span
      className="flex items-center gap-1.5 text-[11px] font-mono text-slate-gray"
      title={
        ok
          ? `Rules deployed to the sandbox at ${new Date(lastDeploy.at).toLocaleTimeString()}`
          : lastDeploy.messages.find((m) => m.severity === 'error')?.text ?? 'deploy rejected'
      }
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}
