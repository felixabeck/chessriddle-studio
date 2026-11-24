import { Button, Group, Loader, ScrollArea, Text } from "@mantine/core";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { CoachError } from "@/bindings";
import { openCoachUsage } from "@/state/coach";
import { CoachText } from "./CoachText";
import classes from "./CoachPanel.module.css";

/**
 * Scrollable transcript frame shared by the Coach and the Assistant.
 * Keeps the newest content in view whenever `scrollKey` changes.
 */
export function AiTranscriptFrame({
  isEmpty,
  emptyText,
  scrollKey,
  children,
}: {
  isEmpty: boolean;
  emptyText: string;
  scrollKey: string | number;
  children: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    viewport.current?.scrollTo({ top: viewport.current.scrollHeight });
  }, [scrollKey]);

  return (
    <ScrollArea className={classes.transcript} viewportRef={viewport}>
      {isEmpty ? (
        <Text className={classes.empty} c="dimmed">
          {emptyText}
        </Text>
      ) : (
        <div className={classes.messages}>{children}</div>
      )}
    </ScrollArea>
  );
}

/** A running turn's question, streamed prose and live activity status. */
export function AiRunningTurnView({
  question,
  text,
  activity,
  testId,
}: {
  question: string;
  text: string;
  activity: string;
  testId: string;
}) {
  return (
    <>
      <div className={classes.question}>{question}</div>
      <div data-testid={testId}>
        {text && (
          <div className={classes.answer}>
            <CoachText text={text} />
          </div>
        )}
        <Group gap="xs" className={classes.status} role="status" aria-live="polite">
          <Loader size="xs" aria-hidden />
          <Text size="sm" c="dimmed">
            {activity}
          </Text>
        </Group>
      </div>
    </>
  );
}

/** Status lines below a finished answer: error text, plan-limit action, or stopped notice. */
export function AiAnswerStatus({
  state,
  error,
  errorText,
}: {
  state: "completed" | "cancelled" | "failed";
  error?: CoachError;
  errorText?: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      {state === "failed" && errorText && (
        <Text size="sm" c="danger" className={classes.status} role="alert">
          {errorText}
        </Text>
      )}
      {/* At the plan's limit the way on is the provider's usage page. */}
      {error === "usageLimitReached" && (
        <div className={classes.status}>
          <Button size="xs" onClick={openCoachUsage}>
            {t("Coach.Plan.ManageUsage")}
          </Button>
        </div>
      )}
      {state === "cancelled" && (
        <Text size="sm" c="dimmed" className={classes.status}>
          {t("Coach.Stopped")}
        </Text>
      )}
    </>
  );
}
