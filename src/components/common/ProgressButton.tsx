import { Box, Button, Group, Progress } from "@mantine/core";
import cx from "clsx";
import { X } from "lucide-react";
import { memo, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { notifyListenerError } from "@/components/files/notifyError";
import { useProgress } from "@/hooks/useProgress";
import IconAction from "./IconAction";
import classes from "./ProgressButton.module.css";

type Props = {
  id: string;
  /** The action is already done (an installed engine). Default false. */
  initInstalled?: boolean;
  onClick: (id: string) => void;
  onCancel?: () => void | Promise<void | { clearedGeneration: bigint | null }>;
  leftIcon?: React.ReactNode;
  labels: {
    /** Shown once the action completed; required unless it can never complete. */
    completed?: string;
    action: string;
    inProgress: string;
    finalizing?: string;
  };
  disabled?: boolean;
  redoable?: boolean;
  /** When false, a succeeded progress job is not treated as the completed action. Default true. */
  completeOnProgressSuccess?: boolean;
  inProgress: boolean;
  setInProgress: (inProgress: boolean) => void;
  /** Whether the button clears native progress after a successful cancellation. */
  clearOnCancel?: boolean;
};

function ProgressButton({
  id,
  initInstalled = false,
  onClick,
  onCancel,
  leftIcon,
  labels,
  disabled,
  redoable,
  completeOnProgressSuccess = true,
  inProgress,
  setInProgress,
  clearOnCancel = true,
}: Props) {
  const { t } = useTranslation();
  const { progress, finished, isActive, clear, fence, item } = useProgress(id);
  const currentId = useRef(id);
  currentId.current = id;
  const completed = initInstalled || (completeOnProgressSuccess && item?.state === "succeeded");

  const showProgress = isActive || inProgress;

  useEffect(() => {
    if (completeOnProgressSuccess && finished) {
      setInProgress(false);
    }
  }, [completeOnProgressSuccess, finished, setInProgress]);

  const handleCancel = useCallback(async () => {
    const cancellingId = id;
    const cancellingGeneration = item?.generation;
    let outcome: Awaited<ReturnType<NonNullable<Props["onCancel"]>>>;
    try {
      outcome = onCancel ? await onCancel() : undefined;
    } catch {
      // Keep the running UI if native cancellation could not be acknowledged.
      return;
    }
    if (currentId.current !== cancellingId) return;
    try {
      if (clearOnCancel) {
        await clear();
      } else {
        fence(
          outcome && "clearedGeneration" in outcome
            ? (outcome.clearedGeneration ??
                (cancellingGeneration === undefined ? null : cancellingGeneration + 1n))
            : null,
        );
      }
      if (currentId.current === cancellingId) setInProgress(false);
    } catch (error) {
      notifyListenerError(error);
    }
  }, [clear, clearOnCancel, fence, id, item?.generation, onCancel, setInProgress]);

  let label: string;
  if (completed) {
    label = labels.completed ?? labels.action;
  } else if (!showProgress) {
    label = labels.action;
  } else if (progress === 100) {
    label = labels.finalizing ?? labels.inProgress;
  } else {
    label = labels.inProgress;
  }

  return (
    <Group gap="min(var(--mantine-spacing-xs), 2%)" wrap="nowrap">
      <Button
        className={cx("wrap-button", classes.button)}
        data-running={showProgress || undefined}
        fullWidth
        onClick={() => {
          onClick(id);
        }}
        disabled={showProgress || (completed && !redoable) || disabled}
        leftSection={<Box className={classes.label}>{leftIcon}</Box>}
        autoContrast
      >
        <span className={classes.label}>{label}</span>
        {!completed &&
          progress !== 0 &&
          item?.state !== "cancelled" &&
          item?.state !== "failed" &&
          (item?.state !== "succeeded" || showProgress) && (
            <Progress
              pos="absolute"
              h="100%"
              value={progress}
              className={classes.progress}
              classNames={{ section: classes.fill }}
              radius="sm"
            />
          )}
      </Button>
      {showProgress && onCancel && (
        <IconAction
          label={t("Common.Cancel", { defaultValue: "Cancel" })}
          variant="default"
          size="lg"
          style={{ flexShrink: 0 }}
          onClick={() => void handleCancel()}
        >
          <X size="1rem" />
        </IconAction>
      )}
    </Group>
  );
}

export default memo(ProgressButton);
