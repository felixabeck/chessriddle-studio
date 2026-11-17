import { atom, useAtomValue, useSetAtom, type getDefaultStore } from "jotai";
import { useEffect } from "react";
import { currentTabAtom } from "@/state/atoms";

/**
 * A save requested from outside the board (the File menu). The mounted `BoardAnalysis` of the
 * named tab consumes it with its own save handlers, so the menu and the in-board controls share
 * one save path and one error handling. Every request is a new object, so a repeated request
 * re-runs the consumer.
 */
export type BoardCommand = { tabId: string; kind: "save" | "saveTo" };

export const boardCommandAtom = atom<BoardCommand | null>(null);

/** Requests Save or Save to… for the active analysis tab; false when none is active. */
export function requestBoardCommand(
    store: ReturnType<typeof getDefaultStore>,
    kind: BoardCommand["kind"],
): boolean {
    const tab = store.get(currentTabAtom);
    if (!tab || tab.type !== "analysis") return false;
    store.set(boardCommandAtom, { tabId: tab.value, kind });
    return true;
}

/** Runs a pending request addressed to `tabId` once, through the board's own handlers. */
export function useBoardCommands(
    tabId: string | undefined,
    handlers: { save: () => void; saveTo: () => void },
): void {
    const command = useAtomValue(boardCommandAtom);
    const setCommand = useSetAtom(boardCommandAtom);
    const { save, saveTo } = handlers;
    useEffect(() => {
        if (!command || tabId === undefined || command.tabId !== tabId) return;
        setCommand(null);
        if (command.kind === "save") save();
        else saveTo();
    }, [command, tabId, setCommand, save, saveTo]);
}
