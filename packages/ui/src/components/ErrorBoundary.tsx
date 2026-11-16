import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Bug, RotateCw } from 'lucide-react';
import { t } from '../i18n/core';
import { Button } from './Button';
import { CopyButton } from './CopyButton';
import { EmptyState } from './Layout';
import { toast } from './Toast';
import { copyText } from '../lib/clipboard';

interface Props {
  children: ReactNode;
  /** Shown in the error state ("Loglar"…). */
  name?: string;
  /** Changing this resets the boundary (e.g. the active tab). */
  resetKey?: unknown;
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called once per crash (after the fallback rendered), e.g. to say so in a toast. */
  onError?: (error: Error, componentStack: string) => void;
}

interface State {
  error: Error | null;
  componentStack: string;
}

/** "Error: message\nstack\ncomponent stack" for the Copy details button. */
export function crashDetails(error: Error, componentStack = ''): string {
  return `${error.name}: ${error.message}\n${error.stack ?? ''}\n${componentStack}`;
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
    try {
      this.props.onError?.(error, info.componentStack ?? '');
    } catch {
      /* a failing report must not crash the boundary */
    }
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
    const details = crashDetails(error, componentStack);
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

/**
 * A shell part (sidebar, top bar, status bar, a banner): a crash shows one small retry button in place
 * of the part, the rest of the window keeps working.
 */
export function PartBoundary({ name, children }: { name: string; children: ReactNode }) {
  return (
    <ErrorBoundary
      name={name}
      fallback={(error, reset) => (
        <div className="part-crash" role="alert">
          <Button size="sm" variant="ghost" icon={RotateCw} onClick={reset} title={error.message}>
            {t('common.crash.part')}
          </Button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

/** A dialog that crashed closed itself: said in a toast with the details to copy, instead of nothing at all. */
export function sayDialogCrashed(error: Error, componentStack = ''): void {
  toast.error(t('common.crash.dialog'), {
    description: error.message,
    duration: 12_000,
    action: { label: t('common.crash.copyDetails'), onClick: () => void copyText(crashDetails(error, componentStack)) },
  });
}

/** Around global dialogs: a crash closes the dialog (opening it again retries) and says so. */
export function DialogBoundary({ name, resetKey, children }: { name: string; resetKey?: unknown; children: ReactNode }) {
  return (
    <ErrorBoundary name={name} resetKey={resetKey} fallback={() => null} onError={sayDialogCrashed}>
      {children}
    </ErrorBoundary>
  );
}

/** The last line of defence around the whole app: a crash outside every view never leaves a blank window. */
export function AppBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      name="app"
      fallback={(error) => (
        <div className="app-crash">
          <EmptyState
            icon={Bug}
            tone="danger"
            title={t('common.crash.app')}
            description={
              <>
                {t('common.crash.appHint')}
                <br />
                <span className="mono text-sm">{error.message}</span>
              </>
            }
            actions={
              <>
                <Button icon={RotateCw} variant="primary" onClick={() => window.location.reload()}>
                  {t('common.crash.reload')}
                </Button>
                <CopyButton value={crashDetails(error)} text={t('common.crash.copyDetails')} size="md" />
              </>
            }
          />
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
