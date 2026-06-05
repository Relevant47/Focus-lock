import { Component, type ErrorInfo, type ReactNode } from 'react';

// Top-level safety net. The app has no other error boundaries, so before this
// component existed any uncaught render error unmounted the entire React tree
// — the user saw a solid-black window with no way to recover. This catches the
// error, prints the stack to the WebKit console, and shows a small recovery
// UI so the rest of the app (navigation, daemon state) stays usable.
//
// Class component because React still requires it: `getDerivedStateFromError`
// and `componentDidCatch` aren't available on function components.

interface Props {
  /// Label shown in the recovery card. e.g. "Page" or "Family".
  scope?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', this.props.scope ?? 'root', error, info.componentStack);
    this.setState({ info });
  }

  reset = (): void => {
    this.setState({ error: null, info: null });
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    const scope = this.props.scope ?? 'page';
    return (
      <div className="p-8 max-w-2xl mx-auto">
        <div className="card p-5 border-danger/40 bg-danger/5 space-y-3">
          <h2 className="text-sm font-semibold text-danger">Something went wrong on this {scope}.</h2>
          <p className="text-xs text-muted leading-relaxed">
            The rest of FocusLock is still working — your blocks and sessions aren't affected.
            You can switch to another tab, or click <span className="text-text">Try again</span> below to retry rendering this one.
          </p>
          <details className="text-[11px] text-faint">
            <summary className="cursor-pointer hover:text-text">Error details</summary>
            <pre className="mt-2 whitespace-pre-wrap font-mono text-[10px] leading-relaxed">
              {error.name}: {error.message}
              {error.stack ? `\n\n${error.stack}` : ''}
              {info?.componentStack ? `\n\nComponent stack:${info.componentStack}` : ''}
            </pre>
          </details>
          <div className="pt-1">
            <button onClick={this.reset} className="btn-ghost px-3 py-1.5 text-xs">
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
