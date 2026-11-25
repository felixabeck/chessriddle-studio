import { useNavigate } from "@tanstack/react-router";
import { useSetAtom, useStore } from "jotai";
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
    /**
     * Positions to open at, in order of preference; the tab opens at the first one its mainline
     * reaches, otherwise at the start.
     */
    targetFens?: readonly string[];
};

type OpenOptions = Pick<
    Parameters<typeof openDatabaseGame>[0],
    "signal" | "ownerId" | "store" | "fromPreview"
>;

/**
 * The one open-a-database-game policy: admit the tab, record it in Recent under the database's
 * title, and land on the board. Resolves to the new tab id, or null when admission declined.
 */
export function useDatabaseGameOpener() {
    const setTabs = useSetAtom(tabsAtom);
    const addRecentFile = useSetAtom(addRecentFileAtom);
    const store = useStore();
    const navigate = useNavigate();
    const { cache } = useSWRConfig();
    return useCallback(
        async (
            { game, database, databaseTitle, targetFens }: DatabaseGameTarget,
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
                targetFens,
                store,
                ...options,
            });
            if (id !== null) await navigate({ to: "/" });
            return id;
        },
        [setTabs, addRecentFile, navigate, cache, store],
    );
}

/** A surface's single-flight open handle for its rows and buttons, reporting failures as toasts. */
export function useOpenDatabaseGame<T>(
    target: (value: T) => DatabaseGameTarget,
    options: Pick<OpenOptions, "fromPreview"> = {},
) {
    const { t } = useTranslation();
    const open = useDatabaseGameOpener();
    const onError = (error: unknown) => notifyUnlessCancelled(t("Common.Error"), error);
    return useGameOpen(
        (value: T) => runTabCreation({ create: () => open(target(value), options), onError }),
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
