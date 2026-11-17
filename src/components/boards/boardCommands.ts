import { atom, type getDefaultStore } from "jotai";
import { currentTabAtom } from "@/state/atoms";

/**
 * A save requested from outside the board (the File menu). The mounted `BoardAnalysis` of the
 * named tab consumes it with its own save handlers, so the menu and the in-board controls share
 * one save path and one error handling.
 */
export type BoardCommand = { tabId: string; kind: "save" | "saveTo"; id: number };

export const boardCommandAtom = atom<BoardCommand | null>(null);

let nextCommandId = 0;

/** Requests a save of the active analysis tab; returns false when no analysis tab is active. */
export function requestBoardCommand(
    store: ReturnType<typeof getDefaultStore>,
    kind: BoardCommand["kind"],
): boolean {
    const tab = store.get(currentTabAtom);
    if (!tab || tab.type !== "analysis") return false;
    nextCommandId += 1;
    store.set(boardCommandAtom, { tabId: tab.value, kind, id: nextCommandId });
    return true;
}
