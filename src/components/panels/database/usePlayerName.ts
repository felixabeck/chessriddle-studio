import useSWRImmutable from "swr/immutable";
import type { DatabaseHandle } from "@/bindings";
import { tauri } from "@/platform/tauri";

/**
 * The name of a database's player, for a header that names the player filter. `undefined` while it
 * loads, without a player, and when the lookup fails: the header then says "Player", as before.
 */
export function usePlayerName(
    database: DatabaseHandle | null,
    player: number | null,
): string | undefined {
    const { data } = useSWRImmutable(
        database && player !== null ? (["player-name", database, player] as const) : null,
        async ([, file, id]) => (await tauri.getPlayer(file, id))?.name ?? undefined,
    );
    return data ?? undefined;
}
