import { AiModelFields, useAiModelSelection } from "@/components/panels/coach/AiModelSelection";
import { useCoachErrorMessages } from "./useCoachErrorMessages";

/** The model the Coach and the Assistant answer with: the same choice as their model button. */
export function CoachModelSetting() {
  const state = useAiModelSelection();
  const errors = useCoachErrorMessages();
  return <AiModelFields state={state} errors={errors} />;
}
