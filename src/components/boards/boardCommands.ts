import { atom, useAtomValue, useSetAtom, type getDefaultStore } from "jotai";
import { useEffect } from "react";
import { currentTabAtom } from "@/state/atoms";

/**
 * A board command requested from outside the board (the File or View menu). The mounted
 * `BoardAnalysis` of the named tab consumes it with its own handlers, so menus and in-board
 * controls share one path and modals stay out of the entry bundle. Every request is a new object,
 * so a repeated request re-runs the consumer.
 */
export type BoardCommand = {
    tabId: string;
    kind: "save" | "saveTo" | "saveLayoutAs" | "manageLayouts";
};

export const boardCommandAtom = atom<BoardCommand | null>(null);

/** Requests a board command for the active analysis tab; false when none is active. */
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
    handlers: {
        save: () => void;
        saveTo: () => void;
        saveLayoutAs: () => void;
        manageLayouts: () => void;
    },
): void {
    const command = useAtomValue(boardCommandAtom);
    const setCommand = useSetAtom(boardCommandAtom);
    const { save, saveTo, saveLayoutAs, manageLayouts } = handlers;
    useEffect(() => {
        if (!command || tabId === undefined || command.tabId !== tabId) return;
        setCommand(null);
        switch (command.kind) {
            case "save":
                save();
                break;
            case "saveTo":
                saveTo();
                break;
            case "saveLayoutAs":
                saveLayoutAs();
                break;
            case "manageLayouts":
                manageLayouts();
                break;
        }
    }, [command, tabId, setCommand, save, saveTo, saveLayoutAs, manageLayouts]);
}
