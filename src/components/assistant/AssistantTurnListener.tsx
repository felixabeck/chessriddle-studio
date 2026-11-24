import {
  createLazyModuleLoader,
  useLazyTurnListener,
} from "@/components/panels/coach/useLazyTurnListener";
import { tauriSubscriptions } from "@/platform/tauri";

const loadAssistantTurns = createLazyModuleLoader(() => import("@/state/assistantTurns"));

/**
 * The one subscription to Assistant turn events, mounted by the application shell while the Coach
 * is available. Answers arrive and are saved even when the Assistant panel is closed.
 */
export function AssistantTurnListener() {
  useLazyTurnListener({
    subscribe: tauriSubscriptions.assistantTurn,
    load: loadAssistantTurns,
    apply: (turns, atoms, payload) => turns.applyAssistantTurnEvent(atoms, payload),
    errorLabel: "Assistant turn event failed",
  });
  return null;
}
