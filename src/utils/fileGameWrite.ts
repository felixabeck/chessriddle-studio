import type { FileWorkspaceHandle, WriteStamp } from "@/bindings";
import { scanBlockingTabs } from "@/state/quitGate";
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
