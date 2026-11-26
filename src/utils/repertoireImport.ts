import type { DrawShape } from "@lichess-org/chessground/draw";
import { makeFen } from "chessops/fen";
import { makeSan } from "chessops/san";
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
    games: TreeState[];
    skipped: number;
};

export type RepertoireImportErrorCode =
    | "too-many-games"
    | "file-changed"
    | "no-usable-games"
    | "io";

export class RepertoireImportError extends Error {
    readonly code: RepertoireImportErrorCode;

    constructor(code: RepertoireImportErrorCode, message: string, cause?: unknown) {
        super(message, cause !== undefined ? { cause } : undefined);
        this.name = "RepertoireImportError";
        this.code = code;
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

type LexedTokens = Parameters<typeof parsePgnTokens>[0];

function parseRepertoireGameTokens(tokens: LexedTokens): TreeState | null {
    const { tree, moveLegalityFailures } = parsePgnTokens(tokens);
    if (moveLegalityFailures.length > 0) return null;
    const [pos] = positionFromFen(tree.root.fen);
    if (!pos) return null;
    return tree;
}

function classifySourceError(error: unknown): never {
    if (errorUnlessCancelled(error) === null) throw error;
    if (error instanceof RepertoireImportError) throw error;
    if (error instanceof PgnPageError) {
        throw new RepertoireImportError(
            "file-changed",
            "The PGN file changed while being read.",
            error,
        );
    }
    const normalized = normalizeError(error);
    throw new RepertoireImportError("io", normalized.message, error);
}

/**
 * Reads every usable game from a PGN file or pasted PGN text for repertoire import.
 *
 * Cancellation propagates as a cancellation error. Whole-source failures (I/O, permission,
 * missing or changed file, game cap exceeded, whole-text lexer refusal, or zero usable games)
 * throw `RepertoireImportError`. Per-game failures (omitted, unlexable, illegal moves, or
 * illegal root FEN) increment `skipped` without aborting the batch.
 */
export async function readRepertoireSource(
    source: RepertoireImportSource,
    options?: { signal?: AbortSignal },
): Promise<ReadRepertoireSourceResult> {
    const signal = options?.signal;
    if (signal?.aborted) throw cancellationError();

    const games: TreeState[] = [];
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
            if (entry.status === "failed") {
                skipped++;
                continue;
            }
            const parsed = parseRepertoireGameTokens(entry.tokens);
            if (!parsed) {
                skipped++;
                continue;
            }
            games.push(parsed);
        }
    } else {
        let totalGames: number;
        try {
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
                    games.push(parsed);
                }
            }
        } catch (error) {
            classifySourceError(error);
        }
    }

    if (games.length === 0) {
        throw new RepertoireImportError(
            "no-usable-games",
            "No usable game could be read from the PGN.",
        );
    }

    return { games, skipped };
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
    const merged = cloneTreeState(target);
    let added = 0;
    let conflicts = 0;
    let unplaced = 0;
    let changed = false;

    if (merged.root.children.length === 0) {
        const firstUsable = games.find((game) => positionFromFen(game.root.fen)[0] !== null);
        if (firstUsable) {
            const seeded = defaultTree(firstUsable.root.fen);
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
    }

    let nodeCount = 0;
    for (const { position } of treeIterator(merged.root)) {
        if (position.length > MAX_TREE_DEPTH) {
            return {
                ok: false,
                reason: "max-depth",
                message: `The merged repertoire exceeds the maximum depth of ${MAX_TREE_DEPTH} half-moves.`,
            };
        }
        if (++nodeCount > MAX_TREE_NODES) {
            return {
                ok: false,
                reason: "max-nodes",
                message: `The merged repertoire exceeds the maximum size of ${MAX_TREE_NODES} positions.`,
            };
        }
    }

    for (const game of games) {
        const [gameRootPos] = positionFromFen(game.root.fen);
        if (!gameRootPos) {
            unplaced++;
            continue;
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
            continue;
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
                    return {
                        ok: false,
                        reason: "max-depth",
                        message: `The merged repertoire exceeds the maximum depth of ${MAX_TREE_DEPTH} half-moves.`,
                    };
                }
                if (nodeCount + 1 > MAX_TREE_NODES) {
                    return {
                        ok: false,
                        reason: "max-nodes",
                        message: `The merged repertoire exceeds the maximum size of ${MAX_TREE_NODES} positions.`,
                    };
                }

                const nextPos = parentPos.clone();
                const san = makeSan(nextPos, move);
                nextPos.play(move);
                const newNode = createNode({
                    fen: makeFen(nextPos.toSetup()),
                    move,
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
            message: `The merged repertoire exceeds the maximum PGN size of ${PGN_TEXT_MAX} bytes.`,
        };
    }

    for (const line of serialized.split("\n")) {
        if (utf8ByteLength(line) >= MAX_PGN_SCANNER_LINE_BYTES) {
            return {
                ok: false,
                reason: "max-line-bytes",
                message: `The merged repertoire contains a PGN line reaching the scanner limit of ${MAX_PGN_SCANNER_LINE_BYTES} bytes.`,
            };
        }
    }

    return {
        ok: true,
        tree: merged,
        report: { added, conflicts, unplaced },
        changed,
    };
}
