/**
 * Output tab — renders the most recent sandbox run. Subscribes to
 * `useRuntimeStore`, so the panel updates the moment `executeWorkspace`
 * finishes regardless of who triggered it (agent or manual button).
 *
 * Deploy block stays as a chip above the run; the run output renders
 * via `<TerminalView>` so it reads as terminal capture (pure-black
 * background, columnar severity, indented payloads) — matches the
 * runOnce drill-in's output section, one vocabulary for both
 * surfaces.
 */
import { useRuntimeStore } from '~/lib/store/runtime';
import { EmptyState } from './EmptyState';
import { TerminalView } from './TerminalView';
import type { DeploySnapshot, RunSnapshot } from '~/lib/store/runtime';
import { formatDuration } from '~/lib/utils/format';

function formatTime(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function OutputTab() {
  const isRunning = useRuntimeStore((s) => s.isRunning);
  const lastDeploy = useRuntimeStore((s) => s.lastDeploy);
  const lastRun = useRuntimeStore((s) => s.lastRun);

  if (!lastDeploy && !lastRun) {
    return (
      <EmptyState
        icon="terminal"
        title={isRunning ? 'Running…' : 'No runs yet'}
        body={
          isRunning
            ? 'The sandbox is deploying rules and executing your code.'
            : 'Hit Run in the workspace toolbar, or ask the agent to call runOnce.'
        }
      />
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-4 pb-6 space-y-4 hide-scrollbar">
      {lastDeploy ? <DeployBlock deploy={lastDeploy} /> : null}
      {lastRun ? <RunBlock run={lastRun} /> : null}
      {isRunning ? (
        <p className="text-[11px] text-slate-gray font-mono">running…</p>
      ) : null}
    </div>
  );
}

function DeployBlock({ deploy }: { deploy: DeploySnapshot }) {
  return (
    <section>
      <header className="flex items-center gap-2 mb-1.5">
        <span className="text-[11px] font-mono text-slate-gray">{formatTime(deploy.at)}</span>
        <span className="text-slate-gray text-[10px]">·</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-gray">
          DEPLOY
        </span>
        <span
          className={`text-[10px] font-medium ${deploy.ok ? 'text-[#a4d4a8]' : 'text-[#f0a0a0]'}`}
        >
          {deploy.ok ? 'ok' : 'failed'}
        </span>
      </header>
      {deploy.messages.length === 0 ? (
        <p className="text-[12px] text-slate-gray">
          {deploy.ok ? 'Rules accepted, no warnings.' : 'Deploy failed without a message.'}
        </p>
      ) : (
        <ul className="space-y-1">
          {deploy.messages.map((m, i) => (
            <li
              key={i}
              className={[
                'text-[12px] font-mono whitespace-pre-wrap break-words',
                m.severity === 'error'
                  ? 'text-[#f0a0a0]'
                  : m.severity === 'warn'
                    ? 'text-[#e6c79c]'
                    : 'text-slate-gray',
              ].join(' ')}
            >
              <span className="text-[10px] uppercase mr-2 opacity-70">{m.severity}</span>
              {m.text}
              {m.line != null ? ` (line ${m.line}${m.column != null ? `:${m.column}` : ''})` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RunBlock({ run }: { run: RunSnapshot }) {
  const meta = [
    formatDuration(run.durationMs),
    `${run.docsTouched} doc${run.docsTouched === 1 ? '' : 's'}`,
    ...(run.errors > 0 ? [`${run.errors} error${run.errors === 1 ? '' : 's'}`] : []),
  ].join(' · ');
  return (
    <section>
      <header className="flex items-center gap-2 mb-2">
        <span className="text-[11px] font-mono text-slate-gray">{formatTime(run.at)}</span>
        <span className="text-slate-gray text-[10px]">·</span>
        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-gray">
          RUN · {run.initiator}
        </span>
        <span
          className={`text-[10px] font-medium ${run.ok ? 'text-[#a4d4a8]' : 'text-[#f0a0a0]'}`}
        >
          {run.ok ? 'ok' : 'failed'}
        </span>
      </header>
      <TerminalView entries={run.entries} title="sandbox stdout" meta={meta} />
    </section>
  );
}
