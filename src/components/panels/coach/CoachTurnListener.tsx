import { tauriSubscriptions } from "@/platform/tauri";
import { createLazyModuleLoader, useLazyTurnListener } from "./useLazyTurnListener";

const loadCoachTurns = createLazyModuleLoader(() => import("@/state/coachTurns"));

/**
 * The one subscription to Coach turn events. It is mounted by the application shell for as long
 * as the window lives, so an answer is received and saved while its tab or panel is not shown.
 * By the time an event can arrive, the panel that started the turn has loaded the turn logic.
 */
export function CoachTurnListener() {
  useLazyTurnListener({
    subscribe: tauriSubscriptions.coachTurn,
    load: loadCoachTurns,
    apply: (turns, atoms, payload) => turns.applyCoachTurnEvent(atoms, payload),
    errorLabel: "Coach turn event failed",
  });
  return null;
}
