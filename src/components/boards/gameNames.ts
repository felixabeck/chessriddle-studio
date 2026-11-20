import type { TreeStore } from "@/state/store/tree";
import { getFileGameName } from "@/utils/files";
import { titleValue } from "@/utils/lineTitle";
import { getTabDestinationFile, isDraftGameOrigin, type Tab, type UpdateTab } from "@/utils/tabs";
import { getGameName, type GameHeaders } from "@/utils/treeReducer";

/** The names a game is filed under, as the naming fields edit them. */
export type GameNames = {
    white: string;
    black: string;
    event: string;
    /** The header a repertoire line's name field edits: the one its title is read from. A line
     * named only by its Event keeps editing Event, so clearing the field leaves it untitled. */
    lineNameKey: "white" | "event";
};

export function initialGameNames(headers: GameHeaders): GameNames {
    return {
        white: titleValue(headers.white) ?? "",
        black: titleValue(headers.black) ?? "",
        event: titleValue(headers.event) ?? "",
        lineNameKey: !titleValue(headers.white) && titleValue(headers.event) ? "event" : "white",
    };
}

/** The headers with the edited names; an untouched field keeps its original spelling. */
export function withGameNames(headers: GameHeaders, names: GameNames): GameHeaders {
    const pick = (original: string, edited: string) =>
        edited.trim() === (titleValue(original) ?? "") ? original : edited.trim();
    return {
        ...headers,
        white: pick(headers.white, names.white),
        black: pick(headers.black, names.black),
        event: pick(headers.event, names.event),
    };
}

/** The tab title follows a changed name, as title editing in the Info panel does. A new game
 * keeps its "New game" title until it has a name. */
function retitledTab(tab: Tab, before: GameHeaders, next: GameHeaders): Tab {
    const file = getTabDestinationFile(tab);
    const titleOf = (headers: GameHeaders) =>
        file ? getFileGameName(headers, file) : getGameName(headers);
    if (titleOf(next) === titleOf(before)) return tab;
    const named =
        file?.metadata.type === "repertoire"
            ? !!titleValue(next.white) || !!titleValue(next.event)
            : getGameName(next) !== "Unknown";
    if (!named && (isDraftGameOrigin(tab.gameOrigin) || !file)) return tab;
    const name = titleOf(next);
    return name === tab.name ? tab : { ...tab, name };
}

/** Writes the edited names to the game and retitles its tab. */
export function applyGameNames({
    store,
    tab,
    updateTab,
    next,
}: {
    store: TreeStore;
    tab: Tab | undefined;
    updateTab: UpdateTab;
    next: GameHeaders;
}) {
    const before = store.getState().headers;
    if (next.white !== before.white || next.black !== before.black || next.event !== before.event)
        store.getState().setHeaders(next);
    if (tab) updateTab(tab.value, (current) => retitledTab(current, before, next));
}
