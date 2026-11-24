import { Button, Group, Text, Textarea } from "@mantine/core";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import classes from "./CoachPanel.module.css";

const MAX_QUESTION_CHARS = 4000;

/**
 * Shared question composer for the Coach and the Assistant: auto-sizing text input,
 * Enter-to-send, the panel's own controls (model button, new conversation), Send/Stop action and
 * missing-selection hint.
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
  return (
    <form
      className={classes.composer}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Group gap="xs" align="flex-end" wrap="wrap">
        <Textarea
          className={classes.input}
          autosize
          minRows={1}
          maxRows={6}
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
        {controls}
        {running ? (
          <Button className={classes.send} variant="default" disabled={stopping} onClick={onStop}>
            {t("Coach.Stop")}
          </Button>
        ) : (
          <Button className={classes.send} type="submit" disabled={!canSend}>
            {t("Coach.Send")}
          </Button>
        )}
      </Group>
      {missingChoice && (
        <Text size="xs" c="dimmed" mt={4}>
          {missingChoice}
        </Text>
      )}
    </form>
  );
}
