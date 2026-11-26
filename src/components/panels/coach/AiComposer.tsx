import { Group, Text, Textarea, useMantineTheme } from "@mantine/core";
import { ArrowUp, Square } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { IconAction } from "@/components/common/IconAction";
import classes from "./CoachPanel.module.css";

const MAX_QUESTION_CHARS = 4000;

/**
 * Shared question composer for the Coach and the Assistant: one framed box with the auto-sizing
 * question field across its full width, and below it a toolbar holding the panel's own controls
 * (model button, new conversation) on the left and the Send/Stop action on the right. Enter sends;
 * the missing-selection hint sits under the box.
 */
export function AiComposer({
  draft,
  onDraftChange,
  onSubmit,
  onStop,
  running,
  stopping,
  canSend,
  placeholder,
  ariaLabel,
  missingChoice,
  controls,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running: boolean;
  stopping: boolean;
  canSend: boolean;
  placeholder: string;
  ariaLabel: string;
  missingChoice: string | null;
  controls: ReactNode;
}) {
  const { t } = useTranslation();
  const theme = useMantineTheme();
  return (
    <form
      className={classes.composer}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className={classes.composerBox}>
        <Textarea
          classNames={{ input: classes.composerInput }}
          variant="unstyled"
          autosize
          minRows={2}
          maxRows={8}
          maxLength={MAX_QUESTION_CHARS}
          aria-label={ariaLabel}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => onDraftChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <Group className={classes.composerToolbar} justify="space-between" gap={4} wrap="nowrap">
          <Group className={classes.composerControls} gap={4} wrap="nowrap">
            {controls}
          </Group>
          {running ? (
            <IconAction
              label={t("Coach.Stop")}
              variant="default"
              radius="xl"
              disabled={stopping}
              onClick={onStop}
            >
              <Square size="0.75rem" fill="currentColor" aria-hidden />
            </IconAction>
          ) : (
            <IconAction
              label={t("Coach.Send")}
              type="submit"
              variant="filled"
              color={theme.primaryColor}
              radius="xl"
              disabled={!canSend}
            >
              <ArrowUp size="1rem" aria-hidden />
            </IconAction>
          )}
        </Group>
      </div>
      {missingChoice && (
        <Text size="xs" c="dimmed" mt={4}>
          {missingChoice}
        </Text>
      )}
    </form>
  );
}
