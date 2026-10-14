import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportError } from '../errorReporting'

interface Props {
  children: ReactNode
  onShowLogs: () => void
}

/**
 * Keeps a view that fails to render from blanking the whole window. The sidebar stays usable, and
 * the error, with the component stack, is in the Logs view.
 */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(
      error,
      'A view failed to render',
      info.componentStack ? `Component stack:${info.componentStack}` : undefined
    )
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="placeholder">
        <div>
          <h2>This view ran into an error</h2>
          <p className="muted">{error.message}</p>
          <div className="actions-row boundary-actions">
            <button className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="btn ghost" onClick={this.props.onShowLogs}>
              Open Logs
            </button>
          </div>
        </div>
      </div>
    )
  }
}
