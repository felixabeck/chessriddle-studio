import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
import { match } from "ts-pattern";
import type { FileMetadata } from "@/components/files/file";
import { errorUnlessCancelled, isPgnContentError, normalizeError } from "@/platform/errors";
import { cancellationError, tauri } from "@/platform/tauri";
import { MAX_TREE_DEPTH, MAX_TREE_NODES, PGN_TEXT_MAX } from "@/state/store/tabStorage";
import {
    getPGN,
    MAX_PGN_SCANNER_LINE_BYTES,
    parsePgnTokens,
    PgnPageError,
    readPgnGamePages,
    utf8ByteLength,
} from "./chess";
import { isSameMove, parseSanOrUci, positionFromFen } from "./chessops";
import {
    createNode,
    defaultTree,
    getBoardState,
    treeIterator,
    type TreeNode,
    type TreeState,
} from "./treeReducer";

export const MAX_REPERTOIRE_IMPORT_GAMES = 2000;
const READ_GAMES_PAGE_SIZE = 100;

export type RepertoireImportSource =
    | { kind: "file"; file: Pick<FileMetadata, "handle"> }
    | { kind: "text"; pgn: string };

export type ReadRepertoireSourceResult = {
    /** Number of usable games delivered to `onGame`. */
    read: number;
    skipped: number;
};

export type RepertoireImportErrorCode =
    | "too-many-games"
    | "too-large"
    | "file-changed"
    | "no-usable-games"
    | "io";

export class RepertoireImportError extends Error {
    readonly code: RepertoireImportErrorCode;
    readonly reason?: RepertoireMergeRefusalReason;

    constructor(
        code: RepertoireImportErrorCode,
        message: string,
        cause?: unknown,
        reason?: RepertoireMergeRefusalReason,
    ) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = "RepertoireImportError";
        this.code = code;
        this.reason = reason;
    }
}

export type RepertoireMergeReport = {
    added: number;
    conflicts: number;
    unplaced: number;
};

export type RepertoireMergeRefusalReason =
    | "max-nodes"
    | "max-depth"
    | "max-bytes"
    | "max-line-bytes";

export type RepertoireMergeResult =
    | { ok: true; tree: TreeState; report: RepertoireMergeReport; changed: boolean }
    | { ok: false; reason: RepertoireMergeRefusalReason; message: string };

export type RepertoireMerger = {
    /**
     * Grafts one game into the merged tree, enforcing `MAX_TREE_NODES` and `MAX_TREE_DEPTH`
     * incrementally. Returns the refusal reason if a limit is exceeded, otherwise `null`.
     */
    add: (game: TreeState) => RepertoireMergeRefusalReason | null;
    /**
     * Finalizes the merge, running the serialized PGN byte (`PGN_TEXT_MAX`) and physical line
     * (`MAX_PGN_SCANNER_LINE_BYTES`) checks once.
     */
    finish: () => RepertoireMergeResult;
};

type LexedTokens = Parameters<typeof parsePgnTokens>[0];

function parseRepertoireGameTokens(tokens: LexedTokens): TreeState | null {
    const { tree, moveLegalityFailures } = parsePgnTokens(tokens);
    if (moveLegalityFailures.length > 0) return null;
    const [pos] = positionFromFen(tree.root.fen);
    if (!pos) return null;
    return tree;
}

function tooLargeError(reason: RepertoireMergeRefusalReason = "max-nodes"): RepertoireImportError {
    return new RepertoireImportError("too-large", refusalMessage(reason), undefined, reason);
}

function fileChangedError(cause: unknown): RepertoireImportError {
    return new RepertoireImportError(
        "file-changed",
        "The PGN file changed while being read.",
        cause,
    );
}

function classifySourceError(error: unknown): never {
    if (errorUnlessCancelled(error) === null) throw error;
    if (error instanceof RepertoireImportError) throw error;
    if (error instanceof PgnPageError) {
        throw fileChangedError(error);
    }
    const normalized = normalizeError(error);
    throw new RepertoireImportError("io", normalized.message, error);
}

/**
 * Streams every usable game from a PGN file or pasted PGN text into `onGame` in source order
 * without retaining a list of parsed games in memory.
 *
 * Cancellation propagates as a cancellation error. If `onGame` returns a refusal reason, reading
 * stops immediately and throws `RepertoireImportError("too-large")` carrying that reason.
 * Whole-source failures (I/O, permission, missing or changed file, game cap exceeded, whole-text
 * lexer refusal, or zero usable games) throw `RepertoireImportError`. Per-game failures (omitted,
 * unlexable, illegal moves, or illegal root FEN) increment `skipped` without aborting the batch.
 */
export async function readRepertoireSource(
    source: RepertoireImportSource,
    options: {
        signal?: AbortSignal;
        onGame: (game: TreeState) => RepertoireMergeRefusalReason | null;
    },
): Promise<ReadRepertoireSourceResult> {
    const { signal, onGame } = options;
    if (signal?.aborted) throw cancellationError();

    let read = 0;
    let skipped = 0;

    if (source.kind === "text") {
        let outcome;
        try {
            outcome = await tauri.lexPgnGames(
                source.pgn,
                MAX_REPERTOIRE_IMPORT_GAMES,
                signal ? { signal } : undefined,
            );
        } catch (error) {
            classifySourceError(error);
        }
        if (signal?.aborted) throw cancellationError();

        if (outcome.status === "tooManyGames") {
            throw new RepertoireImportError(
                "too-many-games",
                `This PGN has ${outcome.count} games, which exceeds the import limit of ${MAX_REPERTOIRE_IMPORT_GAMES}.`,
            );
        }

        for (const entry of outcome.games) {
            if (signal?.aborted) throw cancellationError();
            const parsed = match(entry)
                .with({ status: "ok" }, ({ tokens }) => parseRepertoireGameTokens(tokens))
                .with({ status: "failed" }, () => null)
                .exhaustive();
            if (!parsed) {
                skipped++;
                continue;
            }
            const refusal = onGame(parsed);
            if (refusal !== null) {
                throw tooLargeError(refusal);
            }
            read++;
        }
    } else {
        let expectedRevision: string;
        let totalGames: number;
        try {
            expectedRevision = await tauri.fileRevision(
                source.file.handle,
                signal ? { signal } : undefined,
            );
            if (signal?.aborted) throw cancellationError();
            totalGames = await tauri.countPgnGames(
                source.file.handle,
                signal ? { signal } : undefined,
            );
        } catch (error) {
            classifySourceError(error);
        }
        if (signal?.aborted) throw cancellationError();

        if (totalGames > MAX_REPERTOIRE_IMPORT_GAMES) {
            throw new RepertoireImportError(
                "too-many-games",
                `This PGN has ${totalGames} games, which exceeds the import limit of ${MAX_REPERTOIRE_IMPORT_GAMES}.`,
            );
        }

        try {
            for await (const { games: page } of readPgnGamePages({
                handle: source.file.handle,
                totalGames,
                pageSize: READ_GAMES_PAGE_SIZE,
                signal,
                expectedRevision,
            })) {
                for (const game of page) {
                    if (signal?.aborted) throw cancellationError();
                    if (!game.present || game.omission != null) {
                        skipped++;
                        continue;
                    }
                    let tokens: LexedTokens;
                    try {
                        tokens = await tauri.lexPgn(game.pgn, signal ? { signal } : undefined);
                    } catch (error) {
                        if (errorUnlessCancelled(error) === null) throw error;
                        if (isPgnContentError(error)) {
                            skipped++;
                            continue;
                        }
                        throw new RepertoireImportError("io", normalizeError(error).message, error);
                    }
                    if (signal?.aborted) throw cancellationError();
                    const parsed = parseRepertoireGameTokens(tokens);
                    if (!parsed) {
                        skipped++;
                        continue;
                    }
                    const refusal = onGame(parsed);
                    if (refusal !== null) {
                        throw tooLargeError(refusal);
                    }
                    read++;
                }
            }
        } catch (error) {
            const category = normalizeError(error).backendCategory;
            if (
                category === "invalid-input" ||
                category === "stale-game" ||
                category === "conflict"
            ) {
                throw fileChangedError(error);
            }
            classifySourceError(error);
        }
    }

    if (read === 0) {
        throw new RepertoireImportError(
            "no-usable-games",
            "No usable game could be read from the PGN.",
        );
    }

    return { read, skipped };
}

function shapeKey(shape: DrawShape): string {
    return `${shape.orig}|${shape.dest ?? shape.orig}|${shape.brush ?? ""}|${
        shape.modifiers?.lineWidth ?? ""
    }`;
}

function cloneShape(shape: DrawShape): DrawShape {
    return shape.modifiers ? { ...shape, modifiers: { ...shape.modifiers } } : { ...shape };
}

function copyAnnotationsToNewNode(target: TreeNode, source: TreeNode): void {
    target.comment = source.comment;
    if (source.startingComment !== undefined) {
        target.startingComment = source.startingComment;
    }
    target.nags = [...source.nags];
    target.shapes = source.shapes.map(cloneShape);
    if (source.commands !== undefined) {
        target.commands = source.commands;
    }
    if (source.score !== null) {
        target.score = structuredClone(source.score);
        target.depth = source.depth;
    }
    if (source.diagram) {
        target.diagram = true;
    }
    if (source.reviewMark) {
        target.reviewMark = true;
    }
}

function mergeAnnotationsOntoExistingNode(target: TreeNode, source: TreeNode): boolean {
    let changed = false;

    for (const nag of source.nags) {
        if (!target.nags.includes(nag)) {
            target.nags.push(nag);
            changed = true;
        }
    }

    if (source.shapes.length > 0) {
        const seen = new Set(target.shapes.map(shapeKey));
        for (const shape of source.shapes) {
            const key = shapeKey(shape);
            if (!seen.has(key)) {
                seen.add(key);
                target.shapes.push(cloneShape(shape));
                changed = true;
            }
        }
    }

    const incomingComment = source.comment.trim();
    if (incomingComment !== "") {
        const existingComment = target.comment.trim();
        if (existingComment === "") {
            target.comment = incomingComment;
            changed = true;
        } else if (!existingComment.includes(incomingComment)) {
            target.comment = `${existingComment} ${incomingComment}`;
            changed = true;
        }
    }

    if (target.startingComment === undefined && source.startingComment !== undefined) {
        target.startingComment = source.startingComment;
        changed = true;
    }

    if (target.commands === undefined && source.commands !== undefined) {
        target.commands = source.commands;
        changed = true;
    }

    if (target.score === null && source.score !== null) {
        target.score = structuredClone(source.score);
        target.depth = source.depth;
        changed = true;
    }

    if (!target.diagram && source.diagram) {
        target.diagram = true;
        changed = true;
    }

    return changed;
}

function cloneTreeNode(root: TreeNode): TreeNode {
    const shallow = (node: TreeNode): TreeNode => ({
        ...node,
        move: node.move ? { ...node.move } : null,
        children: [],
        score: node.score ? structuredClone(node.score) : null,
        ...(node.engineScore !== undefined
            ? { engineScore: structuredClone(node.engineScore) }
            : {}),
        shapes: node.shapes.map(cloneShape),
        nags: [...node.nags],
        ...(node.gameEnd !== undefined ? { gameEnd: { ...node.gameEnd } } : {}),
    });

    const clonedRoot = shallow(root);
    const stack: Array<{ source: TreeNode; copy: TreeNode }> = [{ source: root, copy: clonedRoot }];
    while (stack.length > 0) {
        const { source, copy } = stack.pop()!;
        for (const child of source.children) {
            const childCopy = shallow(child);
            copy.children.push(childCopy);
            stack.push({ source: child, copy: childCopy });
        }
    }
    return clonedRoot;
}

function cloneTreeState(target: TreeState): TreeState {
    return {
        root: cloneTreeNode(target.root),
        headers: structuredClone(target.headers),
        position: [...target.position],
        dirty: target.dirty,
        sourceStamp: target.sourceStamp,
        appendAttempted: target.appendAttempted,
        ...(target.storeAttempts !== undefined ? { storeAttempts: [...target.storeAttempts] } : {}),
        report: structuredClone(target.report),
        ...(target.puzzleSession !== undefined
            ? { puzzleSession: structuredClone(target.puzzleSession) }
            : {}),
        ...(target.coachSession !== undefined
            ? { coachSession: structuredClone(target.coachSession) }
            : {}),
        ...(target.scoresheetReview !== undefined
            ? { scoresheetReview: structuredClone(target.scoresheetReview) }
            : {}),
    };
}

function refusalMessage(reason: RepertoireMergeRefusalReason): string {
    switch (reason) {
        case "max-depth":
            return `The merged repertoire exceeds the maximum depth of ${MAX_TREE_DEPTH} half-moves.`;
        case "max-nodes":
            return `The merged repertoire exceeds the maximum size of ${MAX_TREE_NODES} positions.`;
        case "max-bytes":
            return `The merged repertoire exceeds the maximum PGN size of ${PGN_TEXT_MAX} bytes.`;
        case "max-line-bytes":
            return `The merged repertoire contains a PGN line reaching the scanner limit of ${MAX_PGN_SCANNER_LINE_BYTES} bytes.`;
    }
}

/**
 * Creates an incremental repertoire merger over a clone of `target` for `orientation`.
 *
 * Clones `target` once, grafts each `add(game)` call with identical anchoring, replay, conflict
 * marking, annotation rules, and node/depth bounds, and runs serialized byte and line-length
 * checks once in `finish()`.
 */
export function createRepertoireMerger(
    target: TreeState,
    orientation: "white" | "black",
): RepertoireMerger {
    const merged = cloneTreeState(target);
    let added = 0;
    let conflicts = 0;
    let unplaced = 0;
    let changed = false;
    let rootSeeded = merged.root.children.length > 0;
    let refusal: RepertoireMergeRefusalReason | null = null;
    let nodeCount = 0;

    for (const { position } of treeIterator(merged.root)) {
        if (position.length > MAX_TREE_DEPTH) {
            refusal = "max-depth";
            break;
        }
        if (++nodeCount > MAX_TREE_NODES) {
            refusal = "max-nodes";
            break;
        }
    }

    const add = (game: TreeState): RepertoireMergeRefusalReason | null => {
        if (refusal !== null) return refusal;

        const [gameRootPos] = positionFromFen(game.root.fen);
        if (!gameRootPos) {
            unplaced++;
            return null;
        }

        if (!rootSeeded && merged.root.children.length === 0) {
            rootSeeded = true;
            const seeded = defaultTree(game.root.fen);
            if (
                seeded.root.fen !== merged.root.fen ||
                seeded.root.halfMoves !== merged.root.halfMoves
            ) {
                copyAnnotationsToNewNode(seeded.root, merged.root);
                merged.root = seeded.root;
                merged.headers = { ...merged.headers, fen: merged.root.fen };
                merged.position = [];
                changed = true;
            }
        }

        const gameBoardState = getBoardState(game.root.fen);
        let anchor: { node: TreeNode; depth: number } | null = null;
        for (const item of treeIterator(merged.root)) {
            if (getBoardState(item.node.fen) === gameBoardState) {
                anchor = { node: item.node, depth: item.position.length };
                break;
            }
        }
        if (!anchor) {
            unplaced++;
            return null;
        }

        if (mergeAnnotationsOntoExistingNode(anchor.node, game.root)) {
            changed = true;
        }

        const stack: Array<{
            targetParent: TreeNode;
            sourceParent: TreeNode;
            targetDepth: number;
        }> = [{ targetParent: anchor.node, sourceParent: game.root, targetDepth: anchor.depth }];

        while (stack.length > 0) {
            const { targetParent, sourceParent, targetDepth } = stack.pop()!;
            if (sourceParent.children.length === 0) continue;

            const [parentPos] = positionFromFen(targetParent.fen);
            if (!parentPos) continue;
            const turn = parentPos.turn;

            const nextFrames: Array<{
                targetParent: TreeNode;
                sourceParent: TreeNode;
                targetDepth: number;
            }> = [];

            for (const sourceChild of sourceParent.children) {
                let move =
                    sourceChild.move && parentPos.isLegal(sourceChild.move)
                        ? sourceChild.move
                        : null;
                if (!move && sourceChild.san) {
                    move = parseSanOrUci(parentPos, sourceChild.san);
                }
                if (!move || !parentPos.isLegal(move)) continue;

                const existing = targetParent.children.find(
                    (candidate) =>
                        candidate.move !== null && isSameMove(parentPos, candidate.move, move),
                );
                if (existing) {
                    if (mergeAnnotationsOntoExistingNode(existing, sourceChild)) {
                        changed = true;
                    }
                    nextFrames.push({
                        targetParent: existing,
                        sourceParent: sourceChild,
                        targetDepth: targetDepth + 1,
                    });
                    continue;
                }

                const childDepth = targetDepth + 1;
                if (childDepth > MAX_TREE_DEPTH) {
                    refusal = "max-depth";
                    return refusal;
                }
                if (nodeCount + 1 > MAX_TREE_NODES) {
                    refusal = "max-nodes";
                    return refusal;
                }

                const nextPos = parentPos.clone();
                const san = makeSan(nextPos, move);
                nextPos.play(move);
                const newNode = createNode({
                    fen: makeFen(nextPos.toSetup()),
                    move: { ...move },
                    san,
                    halfMoves: targetParent.halfMoves + 1,
                });
                copyAnnotationsToNewNode(newNode, sourceChild);

                if (turn === orientation && targetParent.children.length > 0) {
                    newNode.reviewMark = true;
                    conflicts++;
                }

                targetParent.children.push(newNode);
                nodeCount++;
                added++;
                changed = true;

                nextFrames.push({
                    targetParent: newNode,
                    sourceParent: sourceChild,
                    targetDepth: childDepth,
                });
            }

            for (let i = nextFrames.length - 1; i >= 0; i--) {
                stack.push(nextFrames[i]);
            }
        }

        return null;
    };

    const finish = (): RepertoireMergeResult => {
        if (refusal !== null) {
            return { ok: false, reason: refusal, message: refusalMessage(refusal) };
        }

        const serialized = getPGN(merged.root, {
            headers: merged.headers,
            glyphs: true,
            comments: true,
            variations: true,
            extraMarkups: true,
        });
        if (utf8ByteLength(serialized) > PGN_TEXT_MAX) {
            return {
                ok: false,
                reason: "max-bytes",
                message: refusalMessage("max-bytes"),
            };
        }

        for (const line of serialized.split("\n")) {
            if (utf8ByteLength(line) >= MAX_PGN_SCANNER_LINE_BYTES) {
                return {
                    ok: false,
                    reason: "max-line-bytes",
                    message: refusalMessage("max-line-bytes"),
                };
            }
        }

        return {
            ok: true,
            tree: merged,
            report: { added, conflicts, unplaced },
            changed,
        };
    };

    return {
        add,
        finish,
    };
}

/**
 * Purely merges `games` into a clone of `target` for a repertoire of `orientation`.
 *
 * The input `target` and `games` are never mutated. Existing move order and main line never
 * change; a conflicting reply for `orientation` is appended with `reviewMark = true`.
 * Refuses without applying if the merged tree exceeds `MAX_TREE_NODES`, `MAX_TREE_DEPTH`,
 * `PGN_TEXT_MAX` serialized UTF-8 bytes, or `MAX_PGN_SCANNER_LINE_BYTES` on any physical line.
 */
export function mergeIntoRepertoire(
    target: TreeState,
    games: readonly TreeState[],
    orientation: "white" | "black",
): RepertoireMergeResult {
    const merger = createRepertoireMerger(target, orientation);
    for (const game of games) {
        if (merger.add(game) !== null) {
            return merger.finish();
        }
    }
    return merger.finish();
}
