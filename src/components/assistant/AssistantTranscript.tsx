import { ArrowUpRight } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import { AiAnswerStatus, AiRunningTurnView } from "@/components/panels/coach/AiTranscriptFrame";
import coachClasses from "@/components/panels/coach/CoachPanel.module.css";
import { CoachText } from "@/components/panels/coach/CoachText";
import { useAssistantErrorMessages } from "@/components/settings/coach/useCoachErrorMessages";
import type {
  AssistantAnswerMessage,
  AssistantMessage,
  AssistantRunningTurn,
} from "@/state/assistant";
import type { AssistantTargetActions, AssistantTargetEntry } from "./targets";
import classes from "./AssistantTranscript.module.css";

const Answer = memo(function Answer({
  message,
  targets,
  targetActions,
}: {
  message: AssistantAnswerMessage;
  targets: ReadonlyMap<string, AssistantTargetEntry>;
  targetActions: AssistantTargetActions;
}) {
  const { t } = useTranslation();
  const errors = useAssistantErrorMessages();
  const errorText =
    message.localError === "topicsLoadFailed"
      ? t("Assistant.Error.TopicsLoadFailed")
      : message.error
        ? errors[message.error]
        : undefined;

  return (
    <div data-testid="assistant-answer">
      {message.segments.length > 0 && (
        <div className={coachClasses.answer}>
          {message.segments.map((segment, index) => {
            if (segment.type === "text") {
              return <CoachText key={index} text={segment.text} />;
            }
            const entry = targets.get(segment.target);
            if (!entry) {
              return <CoachText key={index} text={segment.target} />;
            }
            return (
              <button
                key={index}
                type="button"
                className={classes.link}
                data-testid="assistant-link"
                data-target-id={entry.id}
                onClick={() => void entry.open(targetActions, message.feedbackDraft)}
              >
                <span>{entry.label}</span>
                <ArrowUpRight size="0.8em" aria-hidden />
              </button>
            );
          })}
        </div>
      )}
      <AiAnswerStatus state={message.state} error={message.error} errorText={errorText} />
    </div>
  );
});

function Running({ turn }: { turn: AssistantRunningTurn }) {
  const { t } = useTranslation();
  const activity = turn.stopping
    ? t("Coach.Stopping")
    : turn.readingTopics && turn.readingTopics.length > 0
      ? t("Assistant.ReadingTopics")
      : t("Coach.Thinking");
  return (
    <AiRunningTurnView
      question={turn.question}
      text={turn.text}
      activity={activity}
      testId="assistant-running"
    />
  );
}

/** The window's Assistant conversation: each question with its answer, then the running turn. */
export function AssistantTranscript({
  messages,
  running,
  targets,
  targetActions,
}: {
  messages: readonly AssistantMessage[];
  running: AssistantRunningTurn | null;
  targets: ReadonlyMap<string, AssistantTargetEntry>;
  targetActions: AssistantTargetActions;
}) {
  return (
    <>
      {messages.map((message) =>
        message.role === "user" ? (
          <div key={message.id} className={coachClasses.question} data-testid="assistant-question">
            {message.text}
          </div>
        ) : (
          <Answer
            key={message.id}
            message={message}
            targets={targets}
            targetActions={targetActions}
          />
        ),
      )}
      {running && !running.orphaned && <Running turn={running} />}
    </>
  );
}
