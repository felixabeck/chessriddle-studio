import type { FileWorkspaceHandle, WriteStamp } from "@/bindings";
import { scanBlockingTabs } from "@/state/quitGate";
import { normalizeError } from "@/platform/errors";
import { readFileGame, setFileGameOrientation } from "@/utils/files";
import { isTabOfFileGame, type Tab } from "@/utils/tabs";

export type TagWriteIdentity = { stamp: string; revision: string };

export function fileGameHasBlockingOpenTab(
    tabs: readonly Tab[],
    handle: FileWorkspaceHandle,
    gameNumber: number,
): boolean {
    return (
        scanBlockingTabs(tabs.filter((tab) => isTabOfFileGame(tab, handle, gameNumber))).length > 0
    );
}

/** The first of `games` that an open tab with unsaved work holds, or `null` when none is. */
export function firstBlockedFileGame(
    tabs: readonly Tab[],
    handle: FileWorkspaceHandle,
    games: Iterable<number>,
): number | null {
    for (const game of games) {
        if (fileGameHasBlockingOpenTab(tabs, handle, game)) return game;
    }
    return null;
}

/**
 * Writes `color` as the `Orientation` tag of each of `games` in `handle`, in order. A game that is
 * no longer present, is omitted as too large, or exceeds the read limit is skipped; any other
 * failure stops the run and is thrown.
 */
export async function writeGamesOrientation(
    handle: FileWorkspaceHandle,
    games: Iterable<number>,
    color: "white" | "black",
): Promise<void> {
    for (const index of games) {
        let game: Awaited<ReturnType<typeof readFileGame>>;
        try {
            game = await readFileGame(handle, index);
        } catch (cause) {
            if (normalizeError(cause).backendCategory === "resource-limit") continue;
            throw cause;
        }
        if (!game.present || game.omission) continue;
        await setFileGameOrientation(handle, index, color, game.stamp, game.revision);
    }
}

export function certainWriteIdentity(written: WriteStamp): TagWriteIdentity | null {
    if (!written.stamp || !written.revision) return null;
    return { stamp: written.stamp, revision: written.revision };
}

export function advanceRowsAfterTagWrite<Row extends { identity?: TagWriteIdentity }>(
    rows: Iterable<readonly [number, Row]>,
    index: number,
    written: TagWriteIdentity,
    previousRevision: string,
    updateEdited: (row: Row) => Row = (row) => row,
): Map<number, Row> {
    return new Map(
        Array.from(rows, ([rowIndex, row]) => [
            rowIndex,
            rowIndex === index
                ? { ...updateEdited(row), identity: written }
                : row.identity?.revision === previousRevision
                  ? { ...row, identity: { ...row.identity, revision: written.revision } }
                  : row,
        ]),
    );
}
