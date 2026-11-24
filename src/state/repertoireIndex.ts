import type { FileWorkspaceHandle, WorkspaceEntry } from "@/bindings";
import { type FileMetadata, workspaceEntryToEntry } from "@/components/files/file";
import { tauri } from "@/platform/tauri";
import { scanChapterPositions } from "@/state/chapterScan";
import { getPGN, parsePGN } from "@/utils/chess";
import { positionFromFen } from "@/utils/chessops";
import { fileWorkspaceKey } from "@/utils/pathCapabilities";
import {
    defaultTree,
    getBoardState,
    locateBoardState,
    type GameHeaders,
    type TreeNode,
} from "@/utils/treeReducer";

/**
 * Where each position occurs in the user's repertoire files.
 *
 * The index holds no game trees: per repertoire file it keeps the file's `FileMetadata`, per
 * chapter the headers and pre-order nodes needed by opponent preparation, and the position map
 * (`getBoardState` → continuing games and paths) used by Coach. It is built one game at a time
 * through the ordinary file commands and the ordinary PGN parser, and a file is read again only
 * when the native side reports another revision for it. Everything is bounded; whenever a bound
 * is hit or a game cannot be read, the index says that it is only partial and why.
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

/** Why a settled repertoire index is incomplete. */
export type RepertoirePartialReason = "listing-failed" | "read-failed" | "bound-reached";

/** Chapter headers retained in the repertoire index. */
export type RepertoireChapterHeaders = Pick<
    GameHeaders,
    "orientation" | "start" | "white" | "black" | "event"
>;

/** One node of an indexed repertoire chapter, stored in pre-order. */
export type RepertoireChapterNode = {
    /** `getBoardState` key of this node's position. */
    boardState: string;
    /** Index of the parent node in `chapter.nodes`, or `-1` for the root. */
    parent: number;
    /** Move played to reach this node, or `null` at the root. */
    san: string | null;
    /** Child-index path from the chapter root. */
    path: number[];
    /** Half-move count of this node, anchored to the chapter's root FEN. */
    halfMoves: number;
    /** Whether this node has at least one child in the chapter tree. */
    hasContinuation: boolean;
};

/** One indexed chapter of a repertoire file. */
export type IndexedRepertoireChapter = {
    /** Zero-based chapter (game) index within the file. */
    chapter: number;
    headers: RepertoireChapterHeaders;
    nodes: readonly RepertoireChapterNode[];
};

/** One indexed repertoire file exposed to readers. */
export type IndexedRepertoireFile = {
    workspaceKey: string;
    file: FileMetadata;
    chapters: readonly IndexedRepertoireChapter[];
    partial: boolean;
};

/** Settled view of the workspace's repertoire index. */
export type RepertoireSnapshot = {
    files: readonly IndexedRepertoireFile[];
    partial: boolean;
    partialReason: RepertoirePartialReason | null;
};

type Occurrence = { game: number; path: number[] };

type IndexedFile = {
    handle: FileWorkspaceHandle;
    name: string;
    metadata: FileMetadata;
    /**
     * The file's native revision when it was read: a change means "read again". `null` when the
     * revision could not be told; such a file is read again at every refresh.
     */
    revision: string | null;
    positions: Map<string, Occurrence[]>;
    chapters: IndexedRepertoireChapter[];
    games: number;
    bytes: number;
    entries: number;
    partial: boolean;
    readFailed: boolean;
    boundReached: boolean;
};

type IndexState = {
    workspace: string;
    files: Map<string, IndexedFile>;
    /** A bound cut the list of files, or a file is only partly indexed. */
    partial: boolean;
    /** Why `partial` is true, or `null` when the index is complete. */
    partialReason: RepertoirePartialReason | null;
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

function fileMetadataOf(entry: WorkspaceEntry, numGames?: number): FileMetadata {
    const converted = workspaceEntryToEntry({
        ...entry,
        gameCount: numGames ?? entry.gameCount ?? 0,
        metadata: entry.metadata ?? { type: "repertoire", tags: [] },
    });
    if (converted.type !== "file") {
        throw new Error("Expected file metadata for repertoire entry");
    }
    return converted;
}

async function indexFile(
    entry: WorkspaceEntry,
    revision: string | null,
    budget: Budget,
    isCurrent: () => boolean,
): Promise<IndexedFile> {
    const listingUnreadable = entry.gameCount === null || entry.readError !== null;
    const file: IndexedFile = {
        handle: entry.handle,
        name: entry.name,
        metadata: fileMetadataOf(entry),
        revision,
        positions: new Map(),
        chapters: [],
        games: 0,
        bytes: 0,
        entries: 0,
        // A file the listing could not read or count is not an empty repertoire.
        partial: listingUnreadable,
        readFailed: listingUnreadable,
        boundReached: false,
    };
    if (listingUnreadable) return file;

    let count: number;
    try {
        count = await tauri.countPgnGames(entry.handle);
    } catch {
        file.partial = true;
        file.readFailed = true;
        return file;
    }
    if (!isCurrent()) {
        file.partial = true;
        return file;
    }
    file.metadata = fileMetadataOf(entry, count);

    let expectedRevision: string | null = revision;
    for (let game = 0; game < count; game++) {
        if (!isCurrent()) {
            file.partial = true;
            break;
        }
        if (budget.games === 0 || budget.bytes <= 0 || budget.entries <= 0) {
            file.partial = true;
            file.boundReached = true;
            break;
        }
        budget.games--;
        file.games++;
        try {
            const {
                pgn,
                present,
                omission,
                revision: gameRevision,
            } = await tauri.readGame(entry.handle, game);
            if (!isCurrent()) {
                file.partial = true;
                break;
            }
            if (expectedRevision === null) {
                expectedRevision = gameRevision;
            } else if (gameRevision !== expectedRevision) {
                // File changed mid-read: stop so chapters from two revisions are not mixed.
                file.partial = true;
                file.readFailed = true;
                break;
            }
            const bytes = encoder.encode(pgn).length;
            // A game the native side left out cannot be read.
            if (!present || omission) {
                file.partial = true;
                file.readFailed = true;
                continue;
            }
            // A game larger than what is left of the byte budget is skipped; smaller ones after
            // it can still fit.
            if (bytes > budget.bytes) {
                file.partial = true;
                file.boundReached = true;
                continue;
            }
            budget.bytes -= bytes;
            file.bytes += bytes;
            const chapterNodes: RepertoireChapterNode[] = [];
            const ancestors: number[] = [];
            let remaining = budget.entries;
            let hitEntriesBound = false;
            const scanResult = await scanChapterPositions(pgn, (occurrence) => {
                if (remaining === 0) {
                    hitEntriesBound = true;
                    return false;
                }
                remaining--;
                const nodeIndex = chapterNodes.length;
                const parent =
                    occurrence.path.length === 0 ? -1 : ancestors[occurrence.path.length - 1];
                ancestors[occurrence.path.length] = nodeIndex;
                chapterNodes.push({
                    boardState: occurrence.boardState,
                    parent,
                    san: occurrence.san,
                    path: occurrence.path,
                    halfMoves: occurrence.halfMoves,
                    hasContinuation: occurrence.hasContinuation,
                });
                return true;
            });
            // A chapter whose start position cannot be set up as a legal position is left out
            // alone so one malformed FEN never poisons a batch statistics request.
            const [startPosition] = positionFromFen(scanResult.headers.fen);
            if (!startPosition) {
                file.partial = true;
                file.readFailed = true;
                continue;
            }
            if (hitEntriesBound) {
                file.partial = true;
                file.boundReached = true;
            }
            budget.entries -= chapterNodes.length;
            file.entries += chapterNodes.length;
            for (const node of chapterNodes) {
                // Coach only asks for positions where the repertoire plays on; leaf nodes stay in
                // `file.chapters` for preparation matching and still count toward `entries`.
                if (!node.hasContinuation) continue;
                const occurrences = file.positions.get(node.boardState);
                if (occurrences) occurrences.push({ game, path: node.path });
                else file.positions.set(node.boardState, [{ game, path: node.path }]);
            }
            file.chapters.push({
                chapter: game,
                headers: {
                    orientation: scanResult.headers.orientation,
                    start: scanResult.headers.start,
                    white: scanResult.headers.white,
                    black: scanResult.headers.black,
                    event: scanResult.headers.event,
                },
                nodes: chapterNodes,
            });
        } catch {
            // A game that cannot be read or parsed is left out; the rest stays usable.
            file.partial = true;
            file.readFailed = true;
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
    let boundReached = listed.length > entries.length;
    let readFailed = listing.unread.length > 0;
    let partial = boundReached || readFailed;
    const indexed = new Map<string, IndexedFile>();
    const orderedFiles = () => {
        const ordered = new Map<string, IndexedFile>();
        for (const entry of entries) {
            const key = fileWorkspaceKey(entry.handle);
            const file = indexed.get(key);
            if (file) ordered.set(key, file);
        }
        return ordered;
    };
    const budget: Budget = { games: bounds.games, bytes: bounds.bytes, entries: bounds.entries };
    const stale: { entry: WorkspaceEntry; revision: string | null }[] = [];
    for (const entry of entries) {
        const revision = await revisionOf(entry);
        if (state !== target) return;
        const known = target.files.get(fileWorkspaceKey(entry.handle));
        // A file indexed in full under the same revision is kept; its share of the budget stays
        // spent.
        if (known && revision !== null && known.revision === revision && !known.partial) {
            indexed.set(fileWorkspaceKey(entry.handle), known);
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
        indexed.set(fileWorkspaceKey(entry.handle), file);
        // Published file by file in listing order, so a question asked during the build uses what
        // is there without scrambling file order.
        target.files = orderedFiles();
    }
    const next = orderedFiles();
    for (const file of next.values()) {
        partial ||= file.partial;
        readFailed ||= file.readFailed;
        boundReached ||= file.boundReached;
    }
    target.files = next;
    target.partial = partial;
    target.partialReason = readFailed ? "read-failed" : boundReached ? "bound-reached" : null;
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
        state = {
            workspace: key,
            files: new Map(),
            partial: true,
            partialReason: null,
            refreshing: null,
        };
    }
    const target = state;
    target.refreshing ??= refresh(target, workspace, bounds)
        .catch(() => {
            target.partial = true;
            target.partialReason = "listing-failed";
        })
        .finally(() => {
            target.refreshing = null;
        });
    return target.refreshing;
}

/**
 * Settled snapshot of the indexed repertoire files for `workspace`: each file's `FileMetadata`
 * and workspace key, its indexed chapters and nodes, whether the index is partial, and why.
 * Returns `null` when no workspace is given, another workspace is indexed, or a refresh is still
 * running.
 */
export function readRepertoireIndex(
    workspace: FileWorkspaceHandle | null,
): RepertoireSnapshot | null {
    if (workspace === null) return null;
    const index = state;
    if (!index || index.workspace !== fileWorkspaceKey(workspace) || index.refreshing !== null) {
        return null;
    }
    const files: IndexedRepertoireFile[] = [];
    for (const [workspaceKey, file] of index.files) {
        files.push({
            workspaceKey,
            file: file.metadata,
            chapters: file.chapters,
            partial: file.partial,
        });
    }
    return {
        files,
        partial: index.partial,
        partialReason: index.partialReason,
    };
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
