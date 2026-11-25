import { Button, Stack, Text } from "@mantine/core";
import { Component, type ReactNode } from "react";
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
