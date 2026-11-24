import { Text } from "@mantine/core";
import { memo, useContext, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { TreeStateContext } from "@/components/common/TreeStateContext";
import { useCoachErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import type { CoachAnswerMessage, CoachMessage, CoachRunningTurn } from "@/state/coachSession";
import { getBoardState, locateBoardState } from "@/utils/treeReducer";
import { AiAnswerStatus, AiRunningTurnView } from "./AiTranscriptFrame";
import { CoachLine } from "./CoachLine";
import { CoachText } from "./CoachText";
import classes from "./CoachPanel.module.css";

const Answer = memo(function Answer({ message }: { message: CoachAnswerMessage }) {
  const { t } = useTranslation();
  const errors = useCoachErrorMessages();
  const store = useContext(TreeStateContext)!;
  const root = useStore(store, (state) => state.root);
  const orientation = useStore(store, (state) => state.headers.orientation) ?? "white";
  // Where the answer's lines can go now: they start from the position the question was asked
  // about, and the game may have changed since. Without that position there is nowhere to insert.
  const target = useMemo(
    () => locateBoardState(root, message.path, getBoardState(message.fen))?.position ?? null,
    [root, message.path, message.fen],
  );
  const insert = (san: string[]) => {
    const state = store.getState();
    // Resolved again at the click: the path must index the tree as it is now.
    const path = locateBoardState(state.root, message.path, getBoardState(message.fen))?.position;
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
      <AiAnswerStatus
        state={message.state}
        error={message.error}
        errorText={message.error ? errors[message.error] : undefined}
      />
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
    <AiRunningTurnView
      question={turn.question}
      text={turn.text}
      activity={activity}
      testId="coach-running"
    />
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
    <>
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
    </>
  );
}
