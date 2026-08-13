import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  stack: string | null;
}

/**
 * Without this, any render-time exception unmounts the whole tree and the user
 * sees a blank page with the reason buried in the browser console. Showing the
 * message on the page is the difference between "it is broken" and a bug
 * report you can act on.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ stack: info.componentStack ?? null });
    console.error('hive dashboard crashed', error, info);
  }

  override render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div style={{ padding: 24, fontFamily: 'var(--mono)', color: 'var(--text)' }}>
        <h2 style={{ color: 'var(--danger)', marginTop: 0 }}>Dashboard crashed</h2>
        <p className="dim">
          The API and agents are unaffected — this is a UI fault. Details below, then reload.
        </p>
        <pre
          style={{
            background: 'var(--bg-inset)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: 12,
            overflow: 'auto',
            maxHeight: '40vh',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error.message}
          {error.stack ? `\n\n${error.stack}` : ''}
          {stack ? `\n\nComponent stack:${stack}` : ''}
        </pre>
        <button className="primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
