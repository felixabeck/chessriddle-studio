import { Button, Stack, Text } from "@mantine/core";
import cx from "clsx";
import { X } from "lucide-react";
import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconAction } from "@/components/common/IconAction";
import { useScaledMaxWidth } from "@/hooks/useScaledMaxWidth";
import { logFailureSafely, safeFailureContext } from "@/platform/errors";
import type { AssistantPanelProps } from "./AssistantPanel";
import classes from "./AssistantPanel.module.css";

const NARROW_OVERLAY_WIDTH_EM = 56;

export type AssistantPanelLoader = () => Promise<{ default: ComponentType<AssistantPanelProps> }>;

const defaultPanelLoader: AssistantPanelLoader = () => import("./AssistantPanel");

class PanelErrorBoundary extends Component<
  {
    onRetry: () => void;
    loadFailedText: string;
    retryLabel: string;
    children: ReactNode;
  },
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: Error) {
    const primaryFailure = safeFailureContext(error);
    void logFailureSafely(
      `Assistant panel failed to load: ${primaryFailure.message}`,
      { operation: "assistant-panel-load", primaryFailure },
      "assistant-panel-load",
    );
  }

  override render() {
    if (this.state.hasError) {
      return (
        <Stack className={classes.fallback} align="flex-start" gap="sm" role="alert">
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

function DockedAssistantPanel({
  onClose,
  createNewTab,
  openAccounts,
  openEngines,
  openSettings,
  loadPanel,
}: AssistantPanelProps & {
  onClose: () => void;
  loadPanel: AssistantPanelLoader;
}) {
  const { t } = useTranslation();
  const narrow = useScaledMaxWidth(NARROW_OVERLAY_WIDTH_EM);
  const [loadState, setLoadState] = useState(() => ({
    attempt: 0,
    Panel: lazy(loadPanel),
  }));
  const LazyPanel = loadState.Panel;

  return (
    <aside
      className={cx(classes.dock, narrow && classes.overlay)}
      aria-label={t("Assistant.Title")}
      data-testid="assistant-panel"
      data-overlay={narrow ? "true" : undefined}
    >
      <div className={classes.titleBar}>
        <h2 className={classes.title}>{t("Assistant.Title")}</h2>
        <IconAction label={t("Assistant.Close")} variant="subtle" onClick={onClose}>
          <X size="1rem" />
        </IconAction>
      </div>
      <div className={classes.body}>
        <PanelErrorBoundary
          key={loadState.attempt}
          onRetry={() =>
            setLoadState((current) => ({
              attempt: current.attempt + 1,
              Panel: lazy(loadPanel),
            }))
          }
          loadFailedText={t("Assistant.LoadFailed")}
          retryLabel={t("Common.Retry")}
        >
          <Suspense fallback={null}>
            <LazyPanel
              createNewTab={createNewTab}
              openAccounts={openAccounts}
              openEngines={openEngines}
              openSettings={openSettings}
            />
          </Suspense>
        </PanelErrorBoundary>
      </div>
    </aside>
  );
}

/**
 * Lazily loads and docks the Assistant panel at the right edge of the window.
 * Below a minimum window width it covers the content area with a close control.
 * A load failure renders an in-place retry message without taking the application shell down.
 */
export function AssistantPanelHost({
  opened,
  onClose,
  createNewTab,
  openAccounts,
  openEngines,
  openSettings,
  loadPanel = defaultPanelLoader,
}: AssistantPanelProps & {
  opened: boolean;
  onClose: () => void;
  loadPanel?: AssistantPanelLoader;
}) {
  if (!opened) return null;
  return (
    <DockedAssistantPanel
      onClose={onClose}
      createNewTab={createNewTab}
      openAccounts={openAccounts}
      openEngines={openEngines}
      openSettings={openSettings}
      loadPanel={loadPanel}
    />
  );
}
