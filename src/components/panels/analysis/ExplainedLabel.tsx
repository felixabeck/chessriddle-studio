import { UnstyledButton } from "@mantine/core";
import cx from "clsx";
import { Info } from "lucide-react";
import { ExplanationTooltip, useExplanationOpen } from "@/components/common/ExplanationTooltip";
import classes from "./AnalysisPanel.module.css";

interface ExplainedLabelProps {
  label: string;
  explanation: string;
  size?: "xs" | "sm";
  dimmed?: boolean;
  className?: string;
}

/**
 * A label paired with a subtle info indicator whose explanation opens on both pointer hover and
 * keyboard focus, rendered on the bordered popover surface.
 */
export function ExplainedLabel({
  label,
  explanation,
  size = "sm",
  dimmed = false,
  className,
}: ExplainedLabelProps) {
  const { opened, ...triggerProps } = useExplanationOpen();

  return (
    <ExplanationTooltip label={explanation} opened={opened}>
      <UnstyledButton
        type="button"
        className={cx(
          classes.explainedTrigger,
          size === "xs" && classes.explainedTriggerXs,
          dimmed && classes.explainedTriggerDimmed,
          className,
        )}
        {...triggerProps}
      >
        <span>{label}</span>
        <Info size={13} aria-hidden="true" className={classes.infoIcon} />
      </UnstyledButton>
    </ExplanationTooltip>
  );
}
