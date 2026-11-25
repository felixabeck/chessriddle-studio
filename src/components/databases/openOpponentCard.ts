import { notifications } from "@mantine/notifications";
import type { createStore } from "jotai";
import type { ScopedMutator } from "swr";
import { notifyUnlessCancelled } from "@/components/files/notifyError";
import { publishDatabaseList } from "@/hooks/useDatabaseList";
import i18n from "@/i18n";
import { errorUnlessCancelled, safeFailureContext, warnSafely } from "@/platform/errors";
import { opponentLinksAtom, pendingPlayerCardAtom } from "@/state/atoms";
import { type DatabaseList, databaseHandleKey } from "@/utils/db";
import { type DatabaseRouteTarget, databaseRouteTarget } from "./databaseRoute";
import { type OpponentPlayer, opponentPlayers } from "./opponentLookup";

type Store = ReturnType<typeof createStore>;

function reportUnavailable(): void {
    notifications.show({
        color: "danger",
        title: i18n.t("Common.Error"),
        message: i18n.t("Databases.OpeningTree.OnlineUnavailable", {
            defaultValue: "The online games could not be read.",
        }),
    });
}

/**
 * Opens an opponent link's downloaded database on its player's Preparation card.
 * Never writes `activeDatabaseViewStore` directly: instead it records a one-shot
 * `pendingPlayerCardAtom` that `DatabaseView` consumes once the route resolves and synchronizes.
 */
export async function openOpponentCard(
    store: Store,
    navigate: (target: DatabaseRouteTarget) => unknown,
    mutateCache: ScopedMutator,
    linkId: string,
): Promise<boolean> {
    const link = store.get(opponentLinksAtom).find((other) => other.id === linkId);
    if (!link?.database) {
        reportUnavailable();
        return false;
    }

    let listing: DatabaseList | undefined;
    try {
        listing = await publishDatabaseList(mutateCache);
    } catch (error) {
        notifyUnlessCancelled(i18n.t("Common.Error"), error, "database");
        return false;
    }

    const entry = listing?.databases.find((database) => database.filename === link.database);
    if (!entry || entry.type !== "success") {
        reportUnavailable();
        return false;
    }

    let players: OpponentPlayer[];
    try {
        players = await opponentPlayers(entry.file, link.accounts);
    } catch (cause) {
        if (errorUnlessCancelled(cause)) {
            warnSafely(
                `The players of an opponent's online games could not be read: ${safeFailureContext(cause).message}`,
            );
            reportUnavailable();
        }
        return false;
    }

    const player = players[0];
    if (!player) {
        reportUnavailable();
        return false;
    }

    store.set(pendingPlayerCardAtom, {
        database: databaseHandleKey(entry.file),
        playerId: player.id,
        playerName: player.name,
    });
    void navigate(databaseRouteTarget(entry));
    return true;
}
