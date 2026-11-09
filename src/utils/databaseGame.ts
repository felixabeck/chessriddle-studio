import type { DatabaseHandle, NormalizedGame } from "@/bindings";
import { databaseGameHeaders } from "./databaseGameTree";
import { createTab } from "./tabs";
import type { RecentEntryInput } from "@/state/recentFiles";
import { gameSignature } from "@/state/gameSignature";
export { gameSignature, normalizeGameSignature } from "@/state/gameSignature";

/** Record only games whose tab has passed admission. Online games have no database owner. */
export async function openDatabaseGame({
    game,
    database,
    databaseTitle,
    setTabs,
    addRecentFile,
    ownerId,
    store,
}: {
    game: NormalizedGame;
    database?: DatabaseHandle | null;
    databaseTitle?: string;
    setTabs: Parameters<typeof createTab>[0]["setTabs"];
    addRecentFile: (entry: RecentEntryInput) => void;
    ownerId?: string;
    store?: Parameters<typeof createTab>[0]["store"];
}) {
    const seed = databaseGameSeed(game, database);
    const id = await createTab({ ...seed, setTabs, ownerId, store });
    if (id !== null && database) {
        addRecentFile({
            kind: "database",
            name: seed.tab.name,
            database,
            gameId: game.id,
            ...(databaseTitle === undefined ? {} : { databaseTitle }),
            ...(game.linked
                ? { linked: { locator: game.linked, signature: gameSignature(game) } }
                : {}),
        });
    }
    return id;
}

/** Keep all headers and the qualified linked occurrence on every database opening path. */
export function databaseGameSeed(
    game: NormalizedGame,
    database?: DatabaseHandle | null,
): Omit<Parameters<typeof createTab>[0], "setTabs"> {
    return {
        tab: { name: `${game.white} - ${game.black}`, type: "analysis" },
        pgn: game.moves,
        databaseGame: game,
        headers: databaseGameHeaders(game),
        gameOrigin: database
            ? {
                  kind: "database",
                  database,
                  gameId: game.id,
                  linked: game.linked ?? undefined,
              }
            : undefined,
    };
}
