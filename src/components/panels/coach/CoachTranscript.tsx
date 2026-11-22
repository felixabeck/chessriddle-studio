import { Group, Loader, Text } from "@mantine/core";
import { memo, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { useCoachErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import type { CoachAnswerMessage, CoachMessage, CoachRunningTurn } from "@/state/coachSession";
import { CoachLine } from "./CoachLine";
import { resolveCoachInsertPath } from "./coachInsert";
import { CoachText } from "./CoachText";
import classes from "./CoachPanel.module.css";

const Answer = memo(function Answer({ message }: { message: CoachAnswerMessage }) {
  const { t } = useTranslation();
  const errors = useCoachErrorMessages();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (state) => state.root);
  const orientation = useStore(store, (state) => state.headers.orientation) ?? "white";
  // Where the answer's lines can go now; the game may have changed since the question.
  const target = useMemo(
    () => resolveCoachInsertPath(root, message.path, message.fen),
    [root, message.path, message.fen],
  );
  const insert = (san: string[]) => {
    const state = store.getState();
    // Resolved again at the click: the path must index the tree as it is now.
    const path = resolveCoachInsertPath(state.root, message.path, message.fen);
    if (!path) return;
    state.goToMove(path);
    state.makeMoves({ payload: san });
  };
  return (
    <div data-testid="coach-answer">
      {message.segments.length > 0 && (
        <div className={classes.answer}>
          {message.segments.map((segment, index) =>
            segment.type === "text" ? (
              <CoachText key={index} text={segment.text} />
            ) : (
              <CoachLine
                key={index}
                fen={message.fen}
                san={segment.san}
                orientation={orientation}
                onInsert={target ? () => insert(segment.san) : undefined}
              />
            ),
          )}
        </div>
      )}
      {message.state === "failed" && message.error && (
        <Text size="sm" c="danger" className={classes.status} role="alert">
          {errors[message.error]}
        </Text>
      )}
      {message.state === "cancelled" && (
        <Text size="sm" c="dimmed" className={classes.status}>
          {t("Coach.Stopped")}
        </Text>
      )}
      {message.failedLines !== undefined && (
        <Text size="xs" c="dimmed" className={classes.status}>
          {t("Coach.FailedLines")}
        </Text>
      )}
    </div>
  );
});

function Running({ turn }: { turn: CoachRunningTurn }) {
  const { t } = useTranslation();
  const checking = turn.checking;
  const line = checking?.line.join(" ");
  const activity = turn.stopping
    ? t("Coach.Stopping")
    : !checking
      ? t("Coach.Thinking")
      : checking.source === "database"
        ? line
          ? t("Coach.LookingUpLine", { line })
          : t("Coach.LookingUpPosition")
        : line
          ? t("Coach.CheckingLine", { line })
          : t("Coach.CheckingPosition");
  return (
    <>
      <div className={classes.question}>{turn.question}</div>
      <div data-testid="coach-running">
        {turn.text && (
          <div className={classes.answer}>
            <CoachText text={turn.text} />
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

/** The conversation of the tab: each question with its answer, then the turn that runs now. */
export function CoachTranscript({
  messages,
  running,
}: {
  messages: readonly CoachMessage[];
  running: CoachRunningTurn | null;
}) {
  return (
    <div className={classes.messages}>
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className={classes.question} data-testid="coach-question">
            {message.text}
          </div>
        ) : (
          <Answer key={message.id} message={message} />
        ),
      )}
      {running && !running.orphaned && <Running turn={running} />}
    </div>
  );
}
