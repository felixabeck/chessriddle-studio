import type { OpponentImportOutcome, OpponentImportRequest } from "@/bindings";
import { tauri, withDownloadTicket } from "@/platform/tauri";

/**
 * Runs the native import of an opponent's online games. `onTicket` receives the id the import
 * reports its progress under and is cancelled by, before the import starts.
 */
export function importOpponentGames(
    request: OpponentImportRequest,
    onTicket: (ticket: string) => void,
): Promise<OpponentImportOutcome> {
    return withDownloadTicket((ticket) => {
        onTicket(ticket);
        return tauri.importOpponentGames(request, ticket);
    });
}
