import { ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AssistantFeedbackDraft } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import classes from "./AssistantTranscript.module.css";
import type { AssistantTargetActions, AssistantTargetEntry } from "./targets";

/**
 * Navigation button for a closed-registry Assistant/Guide target.
 * Synchronous throws and rejected `open` promises are reported through `notifyUnlessCancelled`.
 */
export function AssistantTargetLink({
  entry,
  actions,
  feedbackDraft,
}: {
  entry: AssistantTargetEntry;
  actions: AssistantTargetActions;
  feedbackDraft?: AssistantFeedbackDraft | null;
}) {
  const { t } = useTranslation();

  const handleClick = () => {
    try {
      void Promise.resolve(entry.open(actions, feedbackDraft)).catch((error: unknown) => {
        notifyUnlessCancelled(t("Common.Error"), error);
      });
    } catch (error: unknown) {
      notifyUnlessCancelled(t("Common.Error"), error);
    }
  };

  return (
    <button
      type="button"
      className={classes.link}
      data-testid="assistant-link"
      data-target-id={entry.id}
      onClick={handleClick}
    >
      <span>{entry.label}</span>
      <ArrowUpRight size="0.8em" aria-hidden />
    </button>
  );
}
