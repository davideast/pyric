/**
 * Class-based error boundary just for the App preview. Functional
 * components can't catch render-phase errors; this is the only React
 * primitive that can. Keeps the boundary local to the preview so a
 * thrown component doesn't take down the rest of the playground.
 *
 * Resets on `resetKey` change — `AppPreview` bumps it whenever the
 * source recompiles, so a fix in the editor lets the preview render
 * again instead of being stuck in error state.
 */
import { Component, type ReactNode } from 'react';

interface Props {
  resetKey: string;
  fallback: (error: Error) => ReactNode;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PreviewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}
