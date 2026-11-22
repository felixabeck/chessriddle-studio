import type { FileWorkspaceHandle, WorkspaceEntry } from "@/bindings";
import { tauri } from "@/platform/tauri";
import { getPGN, parsePGN } from "@/utils/chess";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import {
    defaultTree,
    getBoardState,
    locateBoardState,
    treeIterator,
    type TreeNode,
} from "@/utils/treeReducer";

/**
 * Where each position occurs in the user's repertoire files.
 *
 * The index holds no game trees: per repertoire file it maps a position (`getBoardState`) to the
 * games and paths where it occurs with a move after it; where a line ends there is nothing to
 * tell. It is built one game at a time through the ordinary file
 * commands and the ordinary PGN parser, and a file is read again only when the native side
 * reports another revision for it. Everything is bounded; whenever a bound is hit or a game cannot
 * be read, the index says that it is only partial.
 */

/** How much of the repertoire files one index holds. */
export type RepertoireBounds = { files: number; games: number; bytes: number; entries: number };
export const REPERTOIRE_BOUNDS: RepertoireBounds = {
    files: 50,
    games: 2000,
    bytes: 32 * 1024 * 1024,
    entries: 300_000,
};
/** The bound the native side enforces on the repertoire text of a turn. */
export const MAX_COACH_REPERTOIRE_BYTES = 8 * 1024;
/** Repertoire games that are read again for one question. */
const MAX_CONTEXT_GAMES = 3;
/** Below this much room another game's continuation is not started. */
const MIN_ENTRY_BYTES = 256;
const ELLIPSIS = " …";

type Occurrence = { game: number; path: number[] };

type IndexedFile = {
    handle: FileWorkspaceHandle;
    name: string;
    /**
     * The file's native revision when it was read: a change means "read again". `null` when the
     * revision could not be told; such a file is read again at every refresh.
     */
    revision: string | null;
    positions: Map<string, Occurrence[]>;
    games: number;
    bytes: number;
    entries: number;
    partial: boolean;
};

type IndexState = {
    workspace: string;
    files: Map<string, IndexedFile>;
    /** A bound cut the list of files, or a file is only partly indexed. */
    partial: boolean;
    /** The refresh that runs now, if any. */
    refreshing: Promise<void> | null;
};

let state: IndexState | null = null;

const encoder = new TextEncoder();

function repertoireFiles(entries: readonly WorkspaceEntry[]): WorkspaceEntry[] {
    const found: WorkspaceEntry[] = [];
    const stack = [...entries].reverse();
    while (stack.length > 0) {
        const entry = stack.pop()!;
        if (entry.kind === "directory") stack.push(...[...entry.children].reverse());
        else if (entry.metadata?.type === "repertoire") found.push(entry);
    }
    return found;
}

/**
 * The native revision of a repertoire file. It follows the file's size and its timestamps below
 * a second, so an edit right after another one is not mistaken for no change.
 */
async function revisionOf(entry: WorkspaceEntry): Promise<string | null> {
    try {
        return await tauri.fileRevision(entry.handle);
    } catch {
        return null;
    }
}

type Budget = { games: number; bytes: number; entries: number };

async function indexFile(
    entry: WorkspaceEntry,
    revision: string | null,
    budget: Budget,
    isCurrent: () => boolean,
): Promise<IndexedFile> {
    const file: IndexedFile = {
        handle: entry.handle,
        name: entry.name,
        revision,
        positions: new Map(),
        games: 0,
        bytes: 0,
        entries: 0,
        // A file the listing could not read or count is not an empty repertoire.
        partial: entry.gameCount === null || entry.readError !== null,
    };
    const count = entry.gameCount ?? 0;
    for (let game = 0; game < count; game++) {
        if (!isCurrent() || budget.games === 0 || budget.bytes <= 0 || budget.entries <= 0) {
            file.partial = true;
            break;
        }
        budget.games--;
        file.games++;
        try {
            const { pgn, present, omission } = await tauri.readGame(entry.handle, game);
            const bytes = encoder.encode(pgn).length;
            // A game the native side left out, or one that is larger than what is left to read.
            if (!present || omission || bytes > budget.bytes) {
                file.partial = true;
                continue;
            }
            budget.bytes -= bytes;
            file.bytes += bytes;
            const tree = await parsePGN(pgn);
            for (const { node, position } of treeIterator(tree.root)) {
                // The end of a line plays nothing; indexed, it would hide the same position
                // where another line of the game goes on.
                if (node.children.length === 0) continue;
                if (budget.entries === 0) {
                    file.partial = true;
                    break;
                }
                budget.entries--;
                file.entries++;
                const key = getBoardState(node.fen);
                const occurrences = file.positions.get(key);
                if (occurrences) occurrences.push({ game, path: position });
                else file.positions.set(key, [{ game, path: position }]);
            }
        } catch {
            // A game that cannot be read or parsed is left out; the rest stays usable.
            file.partial = true;
        }
    }
    return file;
}

async function refresh(
    target: IndexState,
    workspace: FileWorkspaceHandle,
    bounds: RepertoireBounds,
): Promise<void> {
    const listing = await tauri.listFileWorkspace(workspace);
    if (state !== target) return;
    const listed = repertoireFiles(listing.entries);
    const entries = listed.slice(0, bounds.files);
    let partial = listed.length > entries.length || listing.unread.length > 0;
    const next = new Map<string, IndexedFile>();
    const budget: Budget = { games: bounds.games, bytes: bounds.bytes, entries: bounds.entries };
    const stale: { entry: WorkspaceEntry; revision: string | null }[] = [];
    for (const entry of entries) {
        const revision = await revisionOf(entry);
        if (state !== target) return;
        const known = target.files.get(fileWorkspaceKey(entry.handle));
        // A file indexed in full under the same revision is kept; its share of the budget stays
        // spent.
        if (known && revision !== null && known.revision === revision && !known.partial) {
            next.set(fileWorkspaceKey(entry.handle), known);
            budget.games -= known.games;
            budget.bytes -= known.bytes;
            budget.entries -= known.entries;
        } else {
            stale.push({ entry, revision });
        }
    }
    budget.games = Math.max(0, budget.games);
    budget.entries = Math.max(0, budget.entries);
    for (const { entry, revision } of stale) {
        const file = await indexFile(entry, revision, budget, () => state === target);
        if (state !== target) return;
        next.set(fileWorkspaceKey(entry.handle), file);
        // Published file by file, so a question asked during the build uses what is there.
        target.files = new Map(next);
    }
    for (const file of next.values()) partial ||= file.partial;
    target.files = next;
    target.partial = partial;
}

/**
 * Brings the index up to date with the workspace's repertoire files. Calls for the same workspace
 * share the refresh that runs; another workspace starts a new index and the old one is dropped.
 * The promise never rejects: a failed refresh leaves the index partial. `bounds` is what the index
 * may hold; tests pass small ones.
 */
export function refreshRepertoireIndex(
    workspace: FileWorkspaceHandle | null,
    bounds: RepertoireBounds = REPERTOIRE_BOUNDS,
): Promise<void> {
    if (workspace === null) {
        state = null;
        return Promise.resolve();
    }
    const key = fileWorkspaceKey(workspace);
    if (state?.workspace !== key) {
        state = { workspace: key, files: new Map(), partial: true, refreshing: null };
    }
    const target = state;
    target.refreshing ??= refresh(target, workspace, bounds)
        .catch(() => {
            target.partial = true;
        })
        .finally(() => {
            target.refreshing = null;
        });
    return target.refreshing;
}

/** `text` within `bytes` of UTF-8, cut at a space and marked when it did not fit. */
function cut(text: string, bytes: number): string {
    if (encoder.encode(text).length <= bytes) return text;
    const room = bytes - encoder.encode(ELLIPSIS).length;
    let end = Math.min(text.length, room);
    while (end > 0 && encoder.encode(text.slice(0, end)).length > room) end = Math.floor(end * 0.9);
    const boundary = text.lastIndexOf(" ", end);
    return `${text.slice(0, boundary > 0 ? boundary : end)}${ELLIPSIS}`;
}

/**
 * What a repertoire game plays below `node`, as movetext with comments and variations. The node
 * becomes the root of what is written, so move numbers continue from the game's own count.
 */
function continuationText(node: TreeNode): string {
    const root: TreeNode = {
        ...defaultTree(node.fen).root,
        fen: node.fen,
        halfMoves: node.halfMoves,
        children: node.children,
    };
    return (
        getPGN(root, {
            headers: null,
            glyphs: true,
            comments: true,
            variations: true,
            extraMarkups: false,
        })
            // The position is in the turn's context already: its header lines are left out.
            .replace(/^(?:\[[^\n]*\]\n)*/, "")
            .replace(/ {2,}/g, " ")
            .trim()
    );
}

export type RepertoireContext = {
    /** What the repertoire plays from the position, as text; `null` if it does not occur. */
    text: string | null;
    /** The repertoire was only partly read, so "not found" is not "not in the repertoire". */
    partial: boolean;
};

/**
 * What the user's repertoire plays from `fen`: for up to three games in which the position
 * occurs, the continuation below it as PGN with the file's name, within
 * `MAX_COACH_REPERTOIRE_BYTES`. The games are read again now, so the text is what the files
 * hold at this moment. The promise never rejects.
 */
export async function repertoireContext(fen: string): Promise<RepertoireContext> {
    const index = state;
    if (!index) return { text: null, partial: false };
    let partial = index.partial || index.refreshing !== null;
    const position = getBoardState(fen);
    const games: { file: IndexedFile; occurrence: Occurrence }[] = [];
    for (const file of index.files.values()) {
        const seen = new Set<number>();
        for (const occurrence of file.positions.get(position) ?? []) {
            if (seen.has(occurrence.game)) continue;
            seen.add(occurrence.game);
            games.push({ file, occurrence });
        }
    }
    if (games.length > MAX_CONTEXT_GAMES) partial = true;
    const parts: string[] = [];
    let budget = MAX_COACH_REPERTOIRE_BYTES;
    for (const { file, occurrence } of games.slice(0, MAX_CONTEXT_GAMES)) {
        if (budget < MIN_ENTRY_BYTES) {
            partial = true;
            break;
        }
        try {
            const { pgn, present, omission } = await tauri.readGame(file.handle, occurrence.game);
            // The game is gone or was left out since it was indexed: not "the repertoire plays
            // nothing here".
            if (!present || omission) {
                partial = true;
                continue;
            }
            const tree = await parsePGN(pgn);
            // The game may have changed since it was indexed: the position where it goes on.
            const found = locateBoardState(
                tree.root,
                occurrence.path,
                position,
                (node) => node.children.length > 0,
            );
            if (!found) continue;
            const continuation = continuationText(found.node);
            const entry = `Repertoire file "${file.name}", game ${occurrence.game + 1}:\n${continuation}`;
            const shown = cut(entry, budget);
            if (shown !== entry) partial = true;
            parts.push(shown);
            budget -= encoder.encode(shown).length + 2;
        } catch {
            partial = true;
        }
    }
    return { text: parts.length > 0 ? parts.join("\n\n") : null, partial };
}

/** Test seam: forgets the index. */
export function resetRepertoireIndexForTests() {
    state = null;
}
