import i18n from "@/i18n";
import type { PgnLineMove, GameMoveResult } from "@/bindings";
import { tauri } from "@/platform/tauri";
import { normalizeError } from "@/platform/errors";
import { invalidateFileDeckAtoms, tabsAtom } from "@/state/atoms";
import { beginFileStructureChange } from "@/state/fileStructureChange";
import { setFileFreshness } from "@/state/fileFreshness";
import {
    clearPracticeFileMigrationFailures,
    ensurePracticeFileReorderReady,
} from "@/state/practiceStorage";
import { scanBlockingTabs } from "@/state/quitGate";
import { withFileWrite } from "@/utils/files";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import {
    isFileBackedTab,
    rebindFileTabsAfterStructureChange,
    type SetTabs,
    type Tab,
} from "@/utils/tabs";
import type { FileMetadata } from "./file";
import type { GameSelectorRow } from "../panels/info/GameSelector";

export type MoveLines = (
    movement: PgnLineMove,
    revision: string,
) => Promise<GameMoveResult | undefined>;

const moving = new Set<string>();

export function affectedMoveSpan(
    movement: PgnLineMove,
    total: number,
    rows: ReadonlyMap<number, GameSelectorRow>,
): [number, number] {
    const { source, before } = movement;
    if (movement.kind === "line") {
        return [Math.min(source, before), Math.min(total - 1, Math.max(source + 1, before))];
    }
    let end = total - 1;
    for (let index = source + 1; index < total; index += 1) {
        const row = rows.get(index);
        if (!row) break;
        if (row.section !== undefined) {
            end = index - 1;
            break;
        }
    }
    return [Math.min(source, before), Math.min(total - 1, Math.max(before, end))];
}

export async function reorderFileLines({
    file,
    movement,
    revision,
    rows,
    workspace,
    setTabs,
    getSelection,
    select,
    reload,
}: {
    file: FileMetadata;
    movement: PgnLineMove;
    revision: string;
    rows: ReadonlyMap<number, GameSelectorRow>;
    workspace: { get: (atom: typeof tabsAtom) => Tab[] };
    setTabs: SetTabs;
    getSelection: () => number;
    select: (index: number) => void;
    reload: (reset: boolean) => void;
}): Promise<GameMoveResult | undefined> {
    const key = fileWorkspaceKey(file.handle);
    if (moving.has(key) || file.metadata.type !== "repertoire") return;
    moving.add(key);
    let release: (() => void) | undefined;
    let mayHaveLanded = false;
    const mark = (state: "conflict" | "unverified") => {
        for (const tab of workspace.get(tabsAtom)) {
            if (isFileBackedTab(tab) && fileWorkspaceKey(tab.gameOrigin.file.handle) === key) {
                setFileFreshness(
                    tab.value,
                    state,
                    state === "conflict" ? { conflictReason: "changed" } : undefined,
                );
            }
        }
    };
    try {
        await ensurePracticeFileReorderReady(key);
        const tabs = workspace.get(tabsAtom);
        const [start, end] = affectedMoveSpan(movement, file.numGames, rows);
        const fileTabs = tabs.filter(
            (tab) => isFileBackedTab(tab) && fileWorkspaceKey(tab.gameOrigin.file.handle) === key,
        );
        const affected = fileTabs.filter(
            (tab) =>
                isFileBackedTab(tab) &&
                tab.gameOrigin.gameNumber >= start &&
                tab.gameOrigin.gameNumber <= end,
        );
        if (scanBlockingTabs(affected).length > 0)
            throw new Error(i18n.t("Files.LineSection.UnsavedTab"));
        const captured = new Map(
            fileTabs.filter(isFileBackedTab).map((tab) => [
                tab.value,
                {
                    numGames: tab.gameOrigin.file.numGames,
                    gameNumber: tab.gameOrigin.gameNumber,
                },
            ]),
        );
        release = beginFileStructureChange(key);
        const result = await withFileWrite(file.handle, () =>
            tauri.moveGames(file.handle, movement, revision),
        );
        if (!result.changed) return result;
        mayHaveLanded = true;
        const ordinals = new Map(result.order.map((old, offset) => [old, result.start + offset]));
        const rebound = rebindFileTabsAfterStructureChange({
            setTabs,
            fileKey: key,
            captured,
            originalCount: file.numGames,
            numGames: file.numGames,
            ordinals,
        });
        if (rebound.matched && !rebound.saved) {
            throw {
                category: "applied-despite-error",
                message: i18n.t("Common.DurabilityUncertain"),
            };
        }
        mark("unverified");
        const selection = getSelection();
        select(ordinals.get(selection) ?? selection);
        reload(false);
        return result;
    } catch (error) {
        const details = normalizeError(error);
        if (
            mayHaveLanded ||
            details.category === "applied-despite-error" ||
            details.backendCategory === "stale-game"
        ) {
            mayHaveLanded = true;
            mark("conflict");
            reload(true);
        }
        if (details.backendCategory === "stale-game")
            throw new Error(i18n.t("Files.LineSection.Stale"));
        throw error;
    } finally {
        try {
            if (mayHaveLanded) {
                try {
                    invalidateFileDeckAtoms(key);
                } finally {
                    clearPracticeFileMigrationFailures(key);
                }
            }
        } finally {
            release?.();
            moving.delete(key);
        }
    }
}
