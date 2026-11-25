import { Button, Stack, Text } from "@mantine/core";
import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { logFailureSafely, safeFailureContext } from "@/platform/errors";

export interface PanelErrorBoundaryProps {
  /** Identifies the failed panel load in native logs (e.g. `"assistant-panel-load"`). */
  operation: string;
  /** Prefix for the logged failure message (e.g. `"Assistant panel failed to load"`). */
  logLabel: string;
  loadFailedText: string;
  retryLabel: string;
  onRetry: () => void;
  className?: string;
  children: ReactNode;
}

/**
 * Isolates a lazily loaded panel so a chunk-load or render failure shows an in-place retry
 * message instead of taking down its host shell.
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, { hasError: boolean }> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: Error) {
    const primaryFailure = safeFailureContext(error);
    void logFailureSafely(
      `${this.props.logLabel}: ${primaryFailure.message}`,
      { operation: this.props.operation, primaryFailure },
      this.props.operation,
    );
  }

  override render() {
    if (this.state.hasError) {
      return (
        <Stack
          className={this.props.className}
          p={this.props.className ? undefined : "md"}
          align="flex-start"
          gap="sm"
          role="alert"
        >
          <Text c="danger">{this.props.loadFailedText}</Text>
          <Button
            variant="default"
            onClick={() => {
              this.setState({ hasError: false });
              this.props.onRetry();
            }}
          >
            {this.props.retryLabel}
          </Button>
        </Stack>
      );
    }
    return this.props.children;
  }
}

export interface RetryableLazyPanelProps<P extends object> {
  load: () => Promise<{ default: ComponentType<P> }>;
  panelProps: P;
  operation: string;
  logLabel: string;
  loadFailedText: string;
  retryLabel: string;
  className?: string;
}

/**
 * Shared retryable lazy panel wrapper: isolates a chunk-load or render failure in
 * `PanelErrorBoundary` and re-creates the `React.lazy` boundary on Retry.
 */
export function RetryableLazyPanel<P extends object>({
  load,
  panelProps,
  operation,
  logLabel,
  loadFailedText,
  retryLabel,
  className,
}: RetryableLazyPanelProps<P>) {
  const [loadState, setLoadState] = useState(() => ({
    attempt: 0,
    Panel: lazy(load),
  }));
  const LazyPanel = loadState.Panel;
  return (
    <PanelErrorBoundary
      key={loadState.attempt}
      operation={operation}
      logLabel={logLabel}
      loadFailedText={loadFailedText}
      retryLabel={retryLabel}
      className={className}
      onRetry={() =>
        setLoadState((current) => ({
          attempt: current.attempt + 1,
          Panel: lazy(load),
        }))
      }
    >
      <Suspense fallback={null}>
        <LazyPanel {...panelProps} />
      </Suspense>
    </PanelErrorBoundary>
  );
}
