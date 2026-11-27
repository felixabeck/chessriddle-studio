import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import type { Color } from "chessops";
import type { TFunction } from "i18next";
import { useSetAtom, useStore } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DatabaseHandle } from "@/bindings";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { failureUnlessCancelled } from "@/platform/errors";
import { tabsAtom } from "@/state/atoms";
import { selectStripTab } from "@/state/stripTab";
import { canonicalTabExplorerOptions, type TabExplorer } from "@/state/workspaceTypes";
import { databaseHandleKey } from "@/utils/db";
import { createTab, runTabCreation, type SetTabs } from "@/utils/tabs";
import type { TreeState } from "@/utils/treeReducer";
import { opponentPlayers } from "./opponentLookup";
import { playerOpeningLine } from "./playerOpeningLine";
import type { OnlineGames } from "./useOnlineGames";

export type PrepareOpponentPin = {
    file: DatabaseHandle;
    player: number;
    color: Color;
    startDate?: string | null;
};

export type PrepareOpponentOnBoardInput = {
    pin?: PrepareOpponentPin;
    online?: OnlineGames;
    includeReference: boolean;
    tabName: string;
    initialTree?: TreeState;
    color?: Color;
};

type PrepareOpponentDeps = {
    setTabs: SetTabs;
    atoms: ReturnType<typeof useStore>;
    navigate: ReturnType<typeof useNavigate>;
    t: TFunction;
    onError: (cause: unknown) => void;
};

/** Opens an analysis tab for an opponent, optionally pinning their database and online games. */
export async function prepareOpponentOnBoard({
    pin,
    online,
    includeReference,
    tabName,
    initialTree,
    color,
    setTabs,
    atoms,
    navigate,
    t,
    onError,
}: PrepareOpponentOnBoardInput & PrepareOpponentDeps): Promise<string | null> {
    // The online games join as a second column once their player is known; without them the
    // board still opens with the card's database (and, for a database card, the reference database).
    let onlinePlayer: number | undefined;
    if (pin && online) {
        // The card's answer is used when it is there; a click before it arrives asks once more.
        let cancelled = false;
        onlinePlayer =
            (online.lookup.kind === "found" ? online.lookup.player : undefined) ??
            (
                await opponentPlayers(online.file, online.accounts).catch((cause) => {
                    if (failureUnlessCancelled(cause)) return [];
                    cancelled = true;
                    return [];
                })
            )[0]?.id;
        // A cancelled lookup was stopped on purpose; no player and a failed lookup both warn.
        if (onlinePlayer === undefined && !cancelled) {
            notifications.show({
                color: "warning",
                message: t("Databases.Opponent.BoardWithoutOnline", {
                    defaultValue: "The online games could not be added to the board.",
                }),
            });
        }
    }

    let explorer: TabExplorer | undefined;
    if (pin) {
        const options = canonicalTabExplorerOptions({
            player: pin.player,
            player_database: databaseHandleKey(pin.file),
            color: pin.color,
            ...(pin.startDate ? { start_date: pin.startDate } : {}),
            result: "any",
        });
        explorer = {
            pinned: pin.file,
            ...(online && onlinePlayer !== undefined
                ? { comparison: { database: online.file, player: onlinePlayer } }
                : {}),
            ...(includeReference ? { further: ["reference"] } : {}),
            ...(options ? { options } : {}),
        };
    }

    const tree = initialTree ?? playerOpeningLine([], pin?.color ?? color ?? "white").tree;

    return runTabCreation({
        create: () =>
            createTab({
                tab: { type: "analysis", name: tabName, ...(explorer ? { explorer } : {}) },
                setTabs,
                initialTree: tree,
            }),
        onSuccess: (id) => {
            if (pin) {
                selectStripTab(atoms, id, "database");
            }
            return navigate({ to: "/" });
        },
        onError,
    });
}

/** Shared React state, store, and navigation wrapper around `prepareOpponentOnBoard`. */
export function usePrepareOpponentOnBoard() {
    const [preparing, setPreparing] = useState(false);
    const setTabs = useSetAtom(tabsAtom);
    const atoms = useStore();
    const navigate = useNavigate();
    const { t } = useTranslation();

    const onError = useCallback(
        (cause: unknown) => notifyUnlessCancelled(t("Common.Error"), cause),
        [t],
    );

    const prepare = useCallback(
        async (input: PrepareOpponentOnBoardInput) => {
            setPreparing(true);
            try {
                await prepareOpponentOnBoard({
                    ...input,
                    setTabs,
                    atoms,
                    navigate,
                    t,
                    onError,
                });
            } finally {
                setPreparing(false);
            }
        },
        [atoms, navigate, onError, setTabs, t],
    );

    return { preparing, prepare };
}
