/**
 * Error boundary scoped to the Firestore tab.
 *
 * A crash inside `<FirestoreTab>` (the `@pyric/ui` Firestore
 * components + the sandbox's snapshot shape) used to propagate to
 * the React root and blank the entire page — no header, no tab
 * bar, no breadcrumb. This boundary contains the failure so the
 * rest of the playground stays interactive and the user sees what
 * actually went wrong.
 *
 * Mirrors `<PreviewErrorBoundary>` (the existing boundary around
 * the live-app preview iframe) — same shape, different scope.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class FirestoreTabBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface the full stack to the console — production-side
    // diagnostics rely on the dev tools. Keep the message tight in
    // the UI itself.
    console.error('FirestoreTab crashed', { error, componentStack: info.componentStack });
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="p-4 space-y-3">
        <div className="rounded-lg border border-[#3a2a2a] bg-[#3a2a2a]/20 p-4 text-[#f0a0a0] text-[13px] space-y-2">
          <div className="font-medium">Firestore tab crashed</div>
          <div className="font-mono text-[12px] break-all">
            {this.state.error.message || 'Unknown error'}
          </div>
          <div className="text-slate-gray text-[12px]">
            Full stack trace in the browser console. The rest of the
            playground is unaffected.
          </div>
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="h-7 px-3 rounded text-[12px] border border-[#2a2a35] text-slate-gray hover:bg-content-bg/60"
        >
          Try again
        </button>
      </div>
    );
  }
}
