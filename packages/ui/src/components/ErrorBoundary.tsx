import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Bug, RotateCw } from 'lucide-react';
import { t } from '../i18n/core';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { EmptyState } from './Layout';

interface Props {
  children: ReactNode;
  /** Shown in the error state ("Loglar"…). */
  name?: string;
  /** Changing this resets the boundary (e.g. the active tab). */
  resetKey?: unknown;
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
  componentStack: string;
}

/** Keeps a crashing view from taking the whole app down; shows a retry state instead. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, componentStack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[durbun] view "${this.props.name ?? 'unknown'}" crashed`, error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  reset = (): void => {
    this.setState({ error: null, componentStack: '' });
  };

  override render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    const details = `${error.name}: ${error.message}\n${error.stack ?? ''}\n${componentStack}`;
    return (
      <EmptyState
        icon={Bug}
        tone="danger"
        title={t('common.crash.title', { name: this.props.name ?? '' })}
        description={<span className="mono text-sm">{error.message}</span>}
        actions={
          <>
            <Button icon={RotateCw} variant="primary" onClick={this.reset}>
              {t('common.retry')}
            </Button>
            <CopyButton value={details} text={t('common.crash.copyDetails')} size="md" />
          </>
        }
      />
    );
  }
}
