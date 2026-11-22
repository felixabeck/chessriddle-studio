import { useStore } from "jotai";
import { warnSafely } from "@/platform/errors";
import { tauriSubscriptions } from "@/platform/tauri";
import { useTauriListener } from "@/platform/useTauriListener";

type CoachTurns = typeof import("@/state/coachTurns");

let coachTurns: Promise<CoachTurns> | undefined;

/**
 * The turn logic, loaded on demand so the application shell stays small. Every event awaits the
 * same promise, so events are applied in the order they came; a failed load is tried again by
 * the next event.
 */
function loadCoachTurns(): Promise<CoachTurns> {
  coachTurns ??= import("@/state/coachTurns").catch((cause: unknown) => {
    coachTurns = undefined;
    throw cause;
  });
  return coachTurns;
}

/**
 * The one subscription to Coach turn events. It is mounted by the application shell for as long
 * as the window lives, so an answer is received and saved while its tab or panel is not shown.
 * By the time an event can arrive, the panel that started the turn has loaded the turn logic.
 */
export function CoachTurnListener() {
  const atoms = useStore();
  useTauriListener(
    tauriSubscriptions.coachTurn,
    async (event) => {
      const { applyCoachTurnEvent } = await loadCoachTurns();
      applyCoachTurnEvent(atoms, event.payload);
    },
    { onError: (error) => warnSafely(`Coach turn event failed: ${error.message}`) },
  );
  return null;
}
