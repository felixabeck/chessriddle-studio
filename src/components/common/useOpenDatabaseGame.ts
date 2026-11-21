import { useNavigate } from "@tanstack/react-router";
import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useSWRConfig } from "swr";
import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { useGameOpen } from "@/components/common/gameOpen";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { DATABASE_LIST_KEY } from "@/hooks/useDatabaseList";
import { addRecentFileAtom, tabsAtom } from "@/state/atoms";
import { openDatabaseGame } from "@/utils/databaseGame";
import { type DatabaseList, sameDatabaseHandle } from "@/utils/db";
import { runTabCreation } from "@/utils/tabs";

export type DatabaseGameTarget = {
    game: NormalizedGame;
    database?: DatabaseHandle | null;
    /** Overrides the title the database listing records for `database`. */
    databaseTitle?: string;
    /** The position the game was listed for; the tab opens there when its mainline reaches it. */
    targetFen?: string;
};

type OpenOptions = Pick<Parameters<typeof openDatabaseGame>[0], "signal" | "ownerId" | "store">;

/**
 * The one open-a-database-game policy: admit the tab, record it in Recent under the database's
 * title, and land on the board. Resolves to the new tab id, or null when admission declined.
 */
export function useDatabaseGameOpener() {
    const setTabs = useSetAtom(tabsAtom);
    const addRecentFile = useSetAtom(addRecentFileAtom);
    const navigate = useNavigate();
    const { cache } = useSWRConfig();
    return useCallback(
        async (
            { game, database, databaseTitle, targetFen }: DatabaseGameTarget,
            options: OpenOptions = {},
        ): Promise<string | null> => {
            const id = await openDatabaseGame({
                game,
                database,
                databaseTitle:
                    databaseTitle ??
                    listedDatabaseTitle(cache.get(DATABASE_LIST_KEY)?.data, database),
                setTabs,
                addRecentFile,
                targetFen,
                ...options,
            });
            if (id !== null) await navigate({ to: "/" });
            return id;
        },
        [setTabs, addRecentFile, navigate, cache],
    );
}

/** A surface's single-flight open handle for its rows and buttons, reporting failures as toasts. */
export function useOpenDatabaseGame<T>(target: (value: T) => DatabaseGameTarget) {
    const { t } = useTranslation();
    const open = useDatabaseGameOpener();
    const onError = (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error);
    return useGameOpen(
        (value: T) => runTabCreation({ create: () => open(target(value)), onError }),
        onError,
    );
}

/** The listing is the only renderer source that maps every handle to its title. */
export function listedDatabaseTitle(
    listing: DatabaseList | undefined,
    database: DatabaseHandle | null | undefined,
): string | undefined {
    if (!database) return undefined;
    const row = listing?.databases.find(
        (entry) => entry.type === "success" && sameDatabaseHandle(entry.file, database),
    );
    return row?.type === "success" ? row.title : undefined;
}
