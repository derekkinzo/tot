import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TEXT } from '../theme';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[tot-mcp] Uncaught render error:', error, info.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%' }}>
        <div style={{ textAlign: 'center', color: TEXT.primary, maxWidth: 420, padding: 32 }}>
          <div style={{ fontSize: 24, marginBottom: 12 }}>Something went wrong</div>
          <p style={{ color: TEXT.secondary, fontSize: 14, marginBottom: 20 }}>
            The visualization encountered an error. Your data is safe on disk.
          </p>
          <button
            onClick={this.handleReset}
            style={{ padding: '8px 20px', background: '#21262d', border: '1px solid #30363d', borderRadius: 6, color: TEXT.primary, fontSize: 14, cursor: 'pointer', marginRight: 12 }}
          >Try again</button>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: '8px 20px', background: 'none', border: '1px solid #30363d', borderRadius: 6, color: TEXT.secondary, fontSize: 14, cursor: 'pointer' }}
          >Reload page</button>
          {this.state.error && (
            <details style={{ marginTop: 20, textAlign: 'left', fontSize: 12, color: TEXT.secondary }}>
              <summary style={{ cursor: 'pointer' }}>Error details</summary>
              <pre style={{ marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{this.state.error.message}</pre>
            </details>
          )}
        </div>
      </div>
    );
  }
}
